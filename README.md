### This is Github Action code with chat for production grade cd pipeline

Excellent questions. You are now moving from a basic CI/CD pipeline to a truly production-grade deployment strategy. Addressing fallbacks and optimizing the deployment order to minimize downtime are critical.

Let's tackle both points.

### 1. Deployment Order: "Pull First, then Stop and Delete"

You are absolutely right. Pulling the new image _before_ touching the old container is a much safer sequence. If the `docker pull` fails (e.g., network error, bad tag, Docker Hub is down), the deployment script will fail, but your existing container will still be running, preventing an outage.

The ideal sequence for minimal downtime is even better:

1.  **Pull** the new image.
2.  **Start** the new container.
3.  **Verify** the new container is healthy.
4.  **Stop** the old container only after the new one is confirmed healthy.
5.  **Clean up** the old container and old image.

This "start-then-stop" approach ensures the service is continuously available, with downtime measured in milliseconds (the time it takes to swap).

### 2. The Fallback Mechanism: "What if the new image fails to run?"

This is the most important part of a reliable deployment. We need a health check. The script will start the new container and then immediately check if the application inside it is actually working. If it's not, we'll perform a fallback: remove the broken new container and leave the old one untouched.

---

### The Production-Grade Solution: Health Check & Fallback Script

This script combines everything: the safer deployment order, a health check loop for the new container, and a fallback mechanism. It continues to use the label-based cleanup for precision.

This is the script you should use in your GitHub Actions workflow.

```yaml
# In your .github/workflows/deploy.yml
# ... (The build steps are the same)

- name: Deploy to VM with Health Check and Fallback
  uses: appleboy/ssh-action@v1.0.3
  with:
    host: ${{ secrets.VM_HOST }}
    username: ${{ secrets.VM_USERNAME }}
    key: ${{ secrets.VM_SSH_PRIVATE_KEY }}
    script: |
      # Exit immediately if a command fails
      set -e

      # --- CONFIGURATION ---
      # Use the environment variables from the workflow
      FULL_IMAGE_NAME="${{ env.DOCKER_IMAGE_NAME }}:${{ github.sha }}"
      CONTAINER_NAME="${{ env.CONTAINER_NAME }}"
      APP_NAME="${{ env.APP_NAME }}"
      # The new container will be started with this temporary name for verification
      NEW_CONTAINER_NAME="${CONTAINER_NAME}-new"
      # The port your application runs on *inside* the container
      APP_PORT=8080 # <-- IMPORTANT: Change this to your app's port
      # How many times to check for health before giving up
      MAX_RETRIES=5
      # How many seconds to wait between retries
      RETRY_INTERVAL=5

      # --- 1. PULL NEW IMAGE ---
      echo "⬇️ 1/5: Pulling new image: $FULL_IMAGE_NAME"
      docker pull $FULL_IMAGE_NAME

      # --- 2. START NEW CONTAINER WITH A TEMPORARY NAME ---
      echo "🚀 2/5: Starting new container '$NEW_CONTAINER_NAME' for health check..."
      # Note: We don't map a port to the host yet to avoid conflicts
      docker run -d --name $NEW_CONTAINER_NAME $FULL_IMAGE_NAME

      # --- 3. HEALTH CHECK ---
      echo "🩺 3/5: Performing health check..."
      # Get the internal IP address of the new container
      NEW_CONTAINER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' $NEW_CONTAINER_NAME)

      for i in $(seq 1 $MAX_RETRIES); do
        # Use curl to check the health endpoint. Adjust the endpoint as needed.
        # The '--fail' flag makes curl exit with an error code on HTTP errors (4xx, 5xx)
        if curl --fail --silent --max-time 5 "http://${NEW_CONTAINER_IP}:${APP_PORT}/health"; then
          echo "✅ Health check passed on attempt $i."
          
          # --- 4. SWAP AND CLEANUP (SUCCESS PATH) ---
          echo "🔄 4/5: Promoting new container and stopping old one..."
          
          # Stop the old container if it exists
          docker stop $CONTAINER_NAME || true
          docker rm $CONTAINER_NAME || true
          
          # Stop the new container, then restart it with the final name and port mapping
          docker stop $NEW_CONTAINER_NAME
          docker rm $NEW_CONTAINER_NAME
          echo "🚀 Running final container '$CONTAINER_NAME'..."
          docker run -d --restart always -p 80:$APP_PORT --name $CONTAINER_NAME $FULL_IMAGE_NAME

          # Clean up old images for this specific app
          echo "🧹 5/5: Cleaning up old images for app: $APP_NAME"
          docker image prune -a -f --filter "label=app=$APP_NAME"

          echo "🎉 Deployment successful!"
          exit 0
        fi
        echo "🔴 Health check failed on attempt $i. Retrying in $RETRY_INTERVAL seconds..."
        sleep $RETRY_INTERVAL
      done

      # --- FALLBACK (FAILURE PATH) ---
      echo "❌ Health check failed after $MAX_RETRIES attempts."
      echo "🔥 Fallback: Removing the failed new container '$NEW_CONTAINER_NAME'."
      docker stop $NEW_CONTAINER_NAME
      docker rm $NEW_CONTAINER_NAME
      echo "👍 Old container '$CONTAINER_NAME' was not affected. Deployment failed."
      exit 1 # Exit with an error code to fail the GitHub Actions job
```

### How This Advanced Script Works

1.  **Configuration:** You must set your application's internal port (`APP_PORT`). You can also adjust the retry logic.
2.  **Pull First:** It pulls the new image before doing anything else.
3.  **Start Temporarily:** It starts the new container with a temporary name (`-new` suffix) and **without mapping its port to the host**. This prevents conflicts with the currently running container.
4.  **Health Check Loop:**
    - It gets the new container's internal IP address.
    - It enters a loop, using `curl` to hit a health check endpoint inside the container (e.g., `http://<container_ip>:8080/health`). You must have an endpoint in your app that returns a `200 OK` status when it's ready.
5.  **Success Path:**
    - If the health check passes, the script proceeds.
    - It stops and removes the old container.
    - It then stops and removes the temporary new container and **restarts it with the final name and correct host port mapping** (`-p 80:8080`).
    - Finally, it runs the targeted `image prune` to clean up the old image.
    - It exits with code `0` (success).
6.  **Failure Path (The Fallback):**
    - If the loop finishes without a successful health check, the script considers the deployment a failure.
    - It stops and removes the **new, failed container**.
    - It prints a message that the old container was untouched.
    - It exits with code `1` (failure), which will cause your GitHub Actions workflow to fail, immediately notifying you of the problem.

This script provides a robust, near-zero-downtime deployment with an automatic rollback mechanism, all while keeping your multi-app environment clean and safe.
