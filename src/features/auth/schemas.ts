import { z } from "zod";

/** bcrypt only uses the first 72 bytes of a password, so longer input is rejected. */
const BCRYPT_MAX_BYTES = 72;
const byteLength = (value: string) => new TextEncoder().encode(value).length;

const emailField = z
  .string({ error: "Email is required." })
  .trim()
  .toLowerCase()
  .min(1, "Email is required.")
  .max(254, "Email is too long.")
  .pipe(z.email("Enter a valid email address."));

export const registerSchema = z.object({
  name: z
    .string({ error: "Name is required." })
    .trim()
    .min(1, "Name is required.")
    .max(80, "Name must be 80 characters or fewer."),
  email: emailField,
  password: z
    .string({ error: "Password is required." })
    .min(8, "Password must be at least 8 characters.")
    .refine((v) => byteLength(v) <= BCRYPT_MAX_BYTES, "Password is too long (max 72 bytes)."),
});

export const loginSchema = z.object({
  email: emailField,
  password: z
    .string({ error: "Password is required." })
    .min(1, "Password is required.")
    .refine((v) => byteLength(v) <= BCRYPT_MAX_BYTES, "Invalid email or password."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
