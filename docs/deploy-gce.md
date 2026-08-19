# Deploying AgentClaw on a single GCE VM

This is the **single-host** deployment: one Compute Engine VM runs the control
plane *and* every agent container (the `local-docker` provider), the same shape
that runs on a local box today. It's right for a **personal or small
single-tenant** deployment. It is **not** the multi-tenant fleet — there's no
`gce` fleet provider yet, so one VM = all your agents, no horizontal scale or
HA. Plan backups (below) accordingly.

Set these expectations first:
- **AI credentials → API keys.** A subscription profile is gated to local hosts
  and is a personal-use gray area on a server; the clean cloud path is an
  Anthropic (or Google) **API key**. See `docs/ai-profiles.md`.
- **No GPU → no local models.** Use a GPU instance only if you actually want the
  Ollama path; otherwise a small general VM is fine.
- **TLS is mandatory once it's reachable.** The app serves plaintext by default;
  don't expose it without TLS in front (step 5).

Throughout, replace `<PROJECT>`, `<ZONE>` (e.g. `us-central1-a`), and
`agentclaw.example.com` with your own.

---

## 1. Create the VM and a persistent data disk

The data disk is separate from the boot disk so you can snapshot it, and reattach
it to a replacement VM if the instance dies.

```bash
gcloud config set project <PROJECT>

# A dedicated persistent disk for ALL durable state (DB + docker volumes).
gcloud compute disks create agentclaw-data --zone <ZONE> --size 50GB --type pd-ssd

# The VM. e2-standard-2 (2 vCPU / 8 GB) comfortably runs a handful of agents.
gcloud compute instances create agentclaw \
  --zone <ZONE> \
  --machine-type e2-standard-2 \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 20GB \
  --disk name=agentclaw-data,device-name=agentclaw-data,mode=rw,auto-delete=no \
  --tags agentclaw

gcloud compute ssh agentclaw --zone <ZONE>
```

Everything below runs **on the VM** unless noted.

---

## 2. Mount the data disk

```bash
# First time only: format the blank disk (skip if reusing an existing one).
sudo mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard \
  /dev/disk/by-id/google-agentclaw-data

sudo mkdir -p /mnt/data
echo '/dev/disk/by-id/google-agentclaw-data /mnt/data ext4 discard,defaults,nofail 0 2' \
  | sudo tee -a /etc/fstab
sudo mount -a
sudo chown "$USER" /mnt/data
```

---

## 3. Install Docker + Node 22, and put Docker's data on the data disk

```bash
# Docker Engine
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"      # log out/in (or `newgrp docker`) after this

# Point docker's storage at the persistent disk, so volumes are snapshot-covered.
sudo mkdir -p /mnt/data/docker
echo '{ "data-root": "/mnt/data/docker" }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker

# Node 22 (nvm keeps it in your user, which is where the service runs it)
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 22
```

Re-SSH after the group change so `docker` works without sudo.

---

## 4. Install AgentClaw

`setup-host.sh` checks prereqs, writes `.env` (a random `AGENTCLAW_SECRET_KEY`
plus a password you choose), builds the runtime image, installs the systemd user
service, and links the `agentclaw` CLI.

```bash
git clone https://github.com/cksci/agentclaw-ai.git /mnt/data/agentclaw
cd /mnt/data/agentclaw
./scripts/setup-host.sh    # writes .env (secret key + your password), builds the image, installs the service
```

Then append the server-specific settings to the `.env` it created (systemd reads
this file; values with special characters use single quotes):

```bash
cat >> .env <<'EOF'
AGENTCLAW_DB=/mnt/data/agentclaw.sqlite
AGENTCLAW_BIND=127.0.0.1
AGENTCLAW_PUBLIC_URL=https://agentclaw.example.com
AGENTCLAW_BACKUP_DIR=/mnt/data/agentclaw-backups
# Optional cap so no one account can exhaust the box:
# AGENTCLAW_MAX_AGENTS_PER_ACCOUNT=10
EOF
```

`AGENTCLAW_BIND=127.0.0.1` keeps the app private so **only the TLS proxy**
(step 5) reaches it. (Skip this line if you use native TLS instead.)

---

## 5. TLS — pick one

**Option A — Caddy reverse proxy (recommended: automatic Let's Encrypt certs).**
Point `agentclaw.example.com`'s DNS A record at the VM's external IP first.

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/caddy.gpg
echo "deb [signed-by=/usr/share/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
  | sudo tee /etc/apt/sources.list.d/caddy.list
sudo apt-get update && sudo apt-get install -y caddy

# One line does TLS + reverse-proxy to the app on loopback:
echo 'agentclaw.example.com { reverse_proxy 127.0.0.1:8080 }' | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Caddy obtains and auto-renews the certificate. Keep `AGENTCLAW_BIND=127.0.0.1`.

**Option B — native TLS (no proxy; you manage the cert).** Put PEM files on the
data disk and point the app at them; set `AGENTCLAW_BIND=0.0.0.0` and open the
app's port in the firewall. Renewal is on you (e.g. a certbot deploy hook).

```bash
cat >> .env <<'EOF'
AGENTCLAW_BIND=0.0.0.0
AGENTCLAW_TLS_CERT=/mnt/data/tls/fullchain.pem
AGENTCLAW_TLS_KEY=/mnt/data/tls/privkey.pem
EOF
```

---

## 6. Firewall — expose only what's needed

GCP default-denies inbound, so you only open the TLS port. This is also what
keeps the raw app port (8080) and the per-agent gateway debug ports (19100+)
unreachable from the internet.

```bash
# From your workstation (not the VM):
gcloud compute firewall-rules create agentclaw-https \
  --allow tcp:443 --target-tags agentclaw --source-ranges 0.0.0.0/0
```

For native TLS on a non-443 port, open that port instead. Never open 8080 or the
gateway range publicly.

---

## 7. AI credentials and bots

- In the web app (⚙ Settings → AI sources) add an **API-key** source — the
  supported cloud path. Different agents can run different models from it
  (`docs/ai-profiles.md`).
- Telegram bots poll **outbound**, so nothing extra is needed for them to work;
  pairing and membership behave exactly as on a local host.

---

## 8. Durability — snapshots, off-box backups, and the key

Three layers, in order of importance:

```bash
# a) Daily snapshots of the whole data disk (fast full restore).
gcloud compute resource-policies create snapshot-schedule agentclaw-daily \
  --region <REGION> --max-retention-days 14 \
  --daily-schedule --start-time 09:00
gcloud compute disks add-resource-policies agentclaw-data \
  --zone <ZONE> --resource-policies agentclaw-daily

# b) Off-box tarballs to GCS. The bundled backup unit already tars the DB +
#    every volume into AGENTCLAW_BACKUP_DIR nightly (03:30); sync that to GCS.
gsutil mb -l <REGION> gs://<PROJECT>-agentclaw-backups
# add a cron/systemd line:  gsutil -m rsync -r /mnt/data/agentclaw-backups gs://<PROJECT>-agentclaw-backups
```

```bash
# c) The secret key — stored SEPARATELY, or a disk backup restores to nothing.
#    AGENTCLAW_SECRET_KEY decrypts the AI credentials in the DB.
grep AGENTCLAW_SECRET_KEY /mnt/data/agentclaw/.env \
  | cut -d= -f2 \
  | gcloud secrets create agentclaw-secret-key --data-file=- --project <PROJECT>
```

To restore on a fresh VM: recreate the disk from a snapshot (or unpack the GCS
tarballs per the header of `scripts/backup-volumes.sh`), put the **same**
`AGENTCLAW_SECRET_KEY` back in `.env`, and start the service. Test this with
`scripts/restore-drill.sh` before you rely on it — an unverified backup isn't one.

---

## 9. Start it and survive reboots

```bash
# The systemd user service was installed by setup-host.sh. Let it run at boot
# without an interactive login:
sudo loginctl enable-linger "$USER"
systemctl --user enable --now agentclaw
systemctl --user enable --now agentclaw-backup.timer
systemctl --user status agentclaw --no-pager
```

Open `https://agentclaw.example.com`, enter the password you chose, and create
an agent.

---

## Multi-user (optional)

For separate accounts rather than one shared password, switch to **identity
mode** (GCP Identity Platform): set `AGENTCLAW_GCP_PROJECT`,
`AGENTCLAW_GOOGLE_CLIENT_ID`, and `AGENTCLAW_IDENTITY_API_KEY` in `.env`
(`docs/identity.md`). Compute is still one VM; identity only changes who can log
in and how agents are scoped.

---

## Hardening checklist

- [ ] TLS in front (Caddy) **or** native TLS — never plaintext on a public IP.
- [ ] Firewall opens **only** 443; 8080 and gateway ports stay internal.
- [ ] `.env` is `chmod 600`; `AGENTCLAW_SECRET_KEY` also in Secret Manager.
- [ ] Data disk on a snapshot schedule **and** tarballs syncing to GCS.
- [ ] `restore-drill.sh` run at least once — restore actually works.
- [ ] AI source is an **API key**, not a subscription.
- [ ] OS auto-updates on (`unattended-upgrades`); rebuild the runtime image on
      OpenClaw bumps (`scripts/build-runtime-image.sh`).
```
