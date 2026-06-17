import { z } from 'zod';

export const usernameSchema = z
  .string()
  .min(2, 'Username must be at least 2 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username can only contain letters, numbers, dots, underscores, and hyphens');

export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters');

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  display_name: z.string().max(64).optional(),
  pow_nonce: z.string(),
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1),
});

export const channelSchema = z.object({
  name: z.string().min(1, 'Channel name is required').max(100),
  type: z.enum(['text', 'voice', 'screen']),
  category_id: z.string().nullable().optional(),
  position: z.number().int().optional(),
});

export const messageSchema = z.object({
  content: z.string().min(1, 'Message content is required').max(4000),
  attachment_id: z.string().optional(),
  reply_to: z.string().optional(),
});

export const messageEditSchema = z.object({
  content: z.string().min(1).max(4000),
});

export const roleSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().optional(),
  position: z.number().int().optional(),
  is_admin: z.boolean().optional(),
  is_host: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  permissions: z.record(z.string(), z.boolean()).optional(),
});

export const serverSettingsSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  password: z.string().optional(),
  is_public: z.boolean().optional(),
  icon_url: z.string().optional(),
  bitrate_kbps: z.number().int().positive().max(512).optional(),
});

export const reactionSchema = z.object({
  messageId: z.string().min(1),
  reactionKey: z.string().min(1),
  reactionType: z.string().optional(),
});

export const dmMessageSchema = z.object({
  content: z.string().min(1).max(4000),
  attachment_id: z.string().optional(),
  encrypted: z.boolean().optional(),
});

export const paginationSchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const searchSchema = z.object({
  query: z.string().min(2).max(200),
  channel_id: z.string().optional(),
  before: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});
