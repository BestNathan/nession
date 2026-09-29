import { copyToClipboard } from '@/shared/lib/clipboard';

export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export async function copyJsonValue(label: string, text: string): Promise<void> {
  await copyToClipboard(text);
  const { toast } = await import('sonner');
  toast.success(`Copied ${label}`);
}
