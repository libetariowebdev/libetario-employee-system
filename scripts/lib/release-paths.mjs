const dataDirectory =
  /^(?:\.local|keys|secrets|uploads|private-uploads[^/]*|private-root[^/]*|backups|backup-scratch|payslip-(?:objects|quarantine))$/i;
const secretFile =
  /(?:\.(?:key|pem|p12|pfx|kdbx|age|dump|pgdump|bak|backup|sql\.gz)$|^id_(?:rsa|ed25519|ecdsa|dsa)$|_deploy_key$)/i;

export function forbiddenReleasePath(file, directory = false) {
  const parts = file.split("/");
  const name = directory ? "" : (parts.pop() ?? "");
  return (
    parts.some((part) => dataDirectory.test(part)) ||
    (/^\.env/i.test(name) && file !== ".env.example") ||
    secretFile.test(name)
  );
}
