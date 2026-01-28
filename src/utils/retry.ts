export async function backoff<T>(
  fn: () => Promise<T>,
  opts?: { retries?: number; baseMs?: number }
): Promise<T> {
  const retries = opts?.retries ?? 3;
  const baseMs = opts?.baseMs ?? 200;
  let attempt = 0;
  let lastErr: any;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const sleepMs = baseMs * Math.pow(2, attempt);
      await new Promise((res) => setTimeout(res, sleepMs));
      attempt += 1;
    }
  }
  throw lastErr;
}
