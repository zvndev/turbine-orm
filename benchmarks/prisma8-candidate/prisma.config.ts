import { defineConfig } from '@prisma/orm-postgres/config';
import { definePrismaConfig } from 'prisma/config';
export default definePrismaConfig({ orm: defineConfig({ contract: './fixture/contract.prisma' }) });
