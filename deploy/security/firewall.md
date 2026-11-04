# Firewall and SSH template

Apply this only in an owner-approved maintenance session on the intended VPS. Keep the provider console and the existing SSH session open. Confirm a second session using the named sudo operator's SSH key before changing SSH settings.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --dry-run enable
sudo ufw enable
sudo ufw status verbose
sudo ss -ltnp
```

Review existing rules before enabling UFW. Apply the same allowed ports at the provider edge and restrict port 22 to known operator sources where practical. Check IPv6 rules if DNS advertises IPv6. Remove broader SSH rules only after the restrictive rule and a second session work. Next and PostgreSQL should listen on loopback only.
