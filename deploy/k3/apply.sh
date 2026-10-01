#!/usr/bin/env bash
# Deploy Elder to the Hetzner K8s cluster, mirroring the k12io secret-injection
# pattern (placeholder -> base64 -> kubectl apply). Logs every mutation.
#
# Usage:
#   KUBECONFIG=/path/to/k12io-production_kubeconfig.yaml \
#   DATABASE_URL='postgresql://...' [IMAGE_LABEL=gitsha] [DRY_RUN=1] ./deploy/k3/apply.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${DATABASE_URL:?set DATABASE_URL (postgresql://... — use the cluster-side URL)}"
LABEL="${IMAGE_LABEL:-$(git -C ../.. rev-parse --short HEAD)}"
MANIFEST_OUT="/tmp/elder-prod-${LABEL}.yml"
KUBECTL=(kubectl)
[ "${DRY_RUN:-0}" = "1" ] && KUBECTL+=(--dry-run=client)
[ "${DRY_RUN:-}" = "server" ] && KUBECTL+=(--dry-run=server)

B64="$(printf %s "$DATABASE_URL" | base64 | tr -d '\n')"
sed -e "s|ELDER_DATABASE_URL_B64|${B64}|" \
    -e "s|IMAGE_LABEL|${LABEL}|" \
    prod.yml > "$MANIFEST_OUT"

echo "== $(date -u +%FT%TZ) apply elder-sis label=$LABEL dry_run=${DRY_RUN:-0} =="
kubectl config current-context
"${KUBECTL[@]}" apply -f "$MANIFEST_OUT"
rm -f "$MANIFEST_OUT"

if [ "${DRY_RUN:-0}" = "0" ] && [ "${DRY_RUN:-}" != "server" ]; then
  kubectl rollout status deployment/elder-prod -n default --timeout=180s
fi