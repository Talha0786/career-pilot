import { z } from 'zod';

export const RegisterRequestSchema = z.object({
  email: z.string().email().max(254),
  // Length only here — strength/hashing is an infrastructure concern (argon2id).
  password: z.string().min(8).max(256),
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const RegisterResponseSchema = z.object({ userId: z.string().uuid() });
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const MeResponseSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;
