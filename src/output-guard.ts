const SECRET_PATTERNS = [
  /-----BEGIN\s+(CERTIFICATE|PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY|ENCRYPTED PRIVATE KEY|PUBLIC KEY)-----[\s\S]*?-----END\s+\1-----/g,
  /MII[A-Za-z0-9+/=]{100,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /client[_-]?secret["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/gi,
  /client[_-]?id["']?\s*[:=]\s*["']?[A-Fa-f0-9-]{36}/gi,
  /api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/gi,
  /secret["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/gi,
  /Bearer\s+[A-Za-z0-9._-]{20,}/g,
  /encryption[_-]?key["']?\s*[:=]\s*["']?[A-Fa-f0-9]{32,}/gi,
];

function maskMatch(match: string): string {
  const prefix = match.slice(0, Math.min(8, Math.floor(match.length / 3)));
  return `${prefix}${"*".repeat(8)}`;
}

export function redactSecrets(input: unknown): unknown {
  if (typeof input === "string") {
    let result = input;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, maskMatch);
    }
    return result;
  }

  if (Array.isArray(input)) {
    return input.map(redactSecrets);
  }

  if (input !== null && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      output[key] = redactSecrets(value);
    }
    return output;
  }

  return input;
}
