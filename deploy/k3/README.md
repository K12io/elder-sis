# deploy/k3 — Elder on the Hetzner K8s cluster

Mirrors the k12io deployment pattern (recon in `../../reference/deploy-recon.md`).

- `prod.yml` — Secret + Deployment + Service + Ingress (host **elder.k12.io**).
- `apply.sh` — injects `DATABASE_URL` (base64) + image label, applies, waits for rollout.

## Deploy

```bash
KUBECONFIG=/path/to/k12io-production_kubeconfig.yaml \
DATABASE_URL='postgresql://...the cluster DB, database `elder`...' \
IMAGE_LABEL=$(git rev-parse --short HEAD) ./deploy/k3/apply.sh
```

Dry-run first (no mutation): `DRY_RUN=server ./deploy/k3/apply.sh` (or `DRY_RUN=1` for client-side).

## Notes

- Image: `timheckel/elder-sis:<label>` on Docker Hub; pulled via the existing
  `k12iocreds` secret (namespace `default`).
- DNS: external-dns creates the `elder.k12.io` Cloudflare record from the Ingress
  annotations (`cloudflare-proxied: "false"` so ACME HTTP-01 works).
- TLS: cert-manager `letsencrypt-prod` issues `elder-tls-cert` automatically.
- The app applies its idempotent migrations at boot; the single-replica `Recreate`
  strategy keeps migration runs single-flight. Old pod serves until the new one is
  Ready only in the RollingUpdate style — here: accept a few seconds of downtime per
  deploy for deterministic migrations.
- Migration-first ordering (k12io's fail-closed rule) is satisfied by construction:
  migrations run inside the new pod's boot transaction before it passes readiness.