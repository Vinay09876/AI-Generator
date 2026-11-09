import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

// Hash of a random value, used so that failed lookups take as long as real
// password checks (prevents discovering registered emails via response timing).
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash() {
  dummyHashPromise ??= bcrypt.hash(crypto.randomUUID(), SALT_ROUNDS);
  return dummyHashPromise;
}

/** Constant-effort password check. Returns false when there is no stored hash. */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(password, await getDummyHash());
    return false;
  }
  return bcrypt.compare(password, hash);
}
