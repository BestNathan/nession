export function promptTelemetry(rendered) {
  if (!rendered || !/^[0-9a-f]{64}$/.test(rendered.template_sha256)) {
    throw new Error('Prompt telemetry requires a rendered template with a SHA-256 digest');
  }
  return {
    id: rendered.template_id,
    version: rendered.template_version,
    sha256: rendered.template_sha256,
  };
}