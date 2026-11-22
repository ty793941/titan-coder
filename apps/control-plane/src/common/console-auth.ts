import { createHash, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export function authenticateConsole(authorization?: string): void {
  const expected = process.env.TITAN_CONSOLE_TOKEN;
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
  if (!expected || !match || !timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(match[1]!).digest(),
  )) throw new UnauthorizedException('invalid console credentials');
}
