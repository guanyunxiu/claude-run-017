/* eslint-disable no-console */
import * as bcrypt from 'bcryptjs';
import * as Y from 'yjs';
import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding demo data...');

  const password = await bcrypt.hash('password123', 10);

  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: {
      email: 'alice@example.com',
      name: 'Alice',
      color: '#f44336',
      passwordHash: password,
    },
  });
  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: {
      email: 'bob@example.com',
      name: 'Bob',
      color: '#2196f3',
      passwordHash: password,
    },
  });
  const carol = await prisma.user.upsert({
    where: { email: 'carol@example.com' },
    update: {},
    create: {
      email: 'carol@example.com',
      name: 'Carol',
      color: '#4caf50',
      passwordHash: password,
    },
  });

  const project = await prisma.project.upsert({
    where: { id: 'seed-project' },
    update: {},
    create: {
      id: 'seed-project',
      name: 'Demo Project',
      ownerId: alice.id,
    },
  });

  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: project.id, userId: bob.id } },
    update: { role: Role.editor },
    create: { projectId: project.id, userId: bob.id, role: Role.editor },
  });
  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: project.id, userId: carol.id } },
    update: { role: Role.viewer },
    create: { projectId: project.id, userId: carol.id, role: Role.viewer },
  });

  const existing = await prisma.file.findFirst({
    where: { projectId: project.id, path: 'src/index.ts' },
  });
  if (!existing) {
    const file = await prisma.file.create({
      data: {
        projectId: project.id,
        name: 'index.ts',
        path: 'src/index.ts',
        language: 'typescript',
      },
    });

    const doc = new Y.Doc();
    doc.getText('content').insert(
      0,
      "// Welcome to the collaborative editor!\n" +
        "// Open this file in two browsers as Alice and Bob.\n\n" +
        "export function greet(name: string): string {\n" +
        "  return `Hello, ${name}!`;\n" +
        "}\n\n" +
        "console.log(greet('world'));\n",
    );
    const update = Y.encodeStateAsUpdate(doc);
    await prisma.documentUpdate.create({
      data: {
        fileId: file.id,
        update: Buffer.from(update),
        sizeBytes: update.length,
      },
    });
  }

  console.log('Seed complete.');
  console.log('Log in with:');
  console.log('  alice@example.com / password123 (owner)');
  console.log('  bob@example.com   / password123 (editor)');
  console.log('  carol@example.com / password123 (viewer)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
