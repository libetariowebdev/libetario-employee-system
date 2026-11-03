import { z } from "zod";
export const supportedTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const uploadPolicySchema = z.strictObject({
  allowedTypes: z
    .array(z.enum(supportedTypes))
    .min(1)
    .max(4)
    .refine((a) => new Set(a).size === a.length),
  maxFileBytes: z.number().int().min(1).max(10485760).default(10485760),
  maxFilesPerDraft: z.number().int().min(1).max(10).default(10),
  dailyBytes: z.number().int().min(1).max(1073741824).default(104857600),
  projectBytes: z.number().int().min(1).max(10737418240).default(1073741824),
  appBytes: z.number().int().min(1).max(53687091200).default(5368709120),
  maxDimension: z.number().int().min(1).max(8192).default(8192),
  maxPixels: z.number().int().min(1).max(20000000).default(20000000),
  maxPdfPages: z.number().int().min(1).max(500).default(500),
  validationTimeoutMs: z.number().int().min(1).max(30000).default(30000),
  uploadAttempts: z.number().int().min(1).max(100).default(20),
  downloadAttempts: z.number().int().min(1).max(1000).default(120),
});
export type UploadPolicy = z.infer<typeof uploadPolicySchema>;
export function safeFileName(raw: string, media: string) {
  const name = raw.normalize("NFKC");
  if (
    name !== name.trim() ||
    Array.from(name).length > 120 ||
    !/^[^.]+\.[^.]+$/.test(name) ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\:%<>"|?*]/u.test(
      name,
    )
  )
    throw new Error("Unsafe filename");
  const [base, ext] = name.split(".");
  if (
    !base.trim() ||
    /[. ]$/.test(base) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)$/i.test(base)
  )
    throw new Error("Unsafe filename");
  const expected: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  };
  if (expected[ext.toLowerCase()] !== media)
    throw new Error("Filename and media type must agree");
  return name;
}
