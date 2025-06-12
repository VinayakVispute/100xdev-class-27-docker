import { prismaClient } from "db/client";

export const revalidate = 60 // revalidate every 60 seconds

export default async function Home() {
  const users = await prismaClient.user.findMany();
  return (
    <div>
      {JSON.stringify(users)}
    </div>
  );
}

