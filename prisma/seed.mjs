/**
 * Seeds an administrator account.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='strong-password-1' npm run db:seed
 *
 * Safe to re-run: an existing user is promoted to ADMIN, never duplicated.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  const name = process.env.ADMIN_NAME || "Nexus Admin";

  if (!email || !password) {
    console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD to seed an admin account.");
    process.exitCode = 1;
    return;
  }
  if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    console.error("ADMIN_PASSWORD must be >= 10 chars and include a letter and a number.");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { role: "ADMIN", status: "ACTIVE", passwordHash },
    create: { email, name, passwordHash, role: "ADMIN", status: "ACTIVE" },
    select: { id: true, email: true, role: true },
  });

  console.log(`Admin ready: ${user.email} (${user.role})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
