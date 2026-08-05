import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function readToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();

  const headerToken = request.headers["x-api-token"];
  return Array.isArray(headerToken) ? headerToken[0] : headerToken;
}

export function createTokenAuthMiddleware(expectedToken: string) {
  return async function tokenAuthMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = readToken(request);
    if (!token || !safeEqual(token, expectedToken)) {
      await reply.code(401).send({
        error: "unauthorized",
        message: "Geçerli Bearer token veya x-api-token gerekli",
      });
    }
  };
}
