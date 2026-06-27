# ── Robinhood Quant Pod — local <-> EC2 sync ────────────────────────────────
# Real host/key/account live in Makefile.local (UNTRACKED). Copy the example:
#     cp templates/Makefile.local.example Makefile.local   # then fill in your values
# Never commit Makefile.local — it is gitignored.
-include Makefile.local

EC2_HOST   ?= ubuntu@your-ec2-host.compute-1.amazonaws.com
SSH_KEY    ?= ~/path/to/your-key.pem
REMOTE_DIR ?= /home/ubuntu/quant_pod
ACCOUNT_ID ?=
LOCAL_DIR  := $(CURDIR)

SSH := ssh -i $(SSH_KEY)

# Only project files move. Secrets, logs, backups, the nested clone never sync.
RSYNC := rsync -avz --no-perms --omit-dir-times -e "$(SSH)" \
  --exclude='.git/' \
  --exclude='Makefile.local' \
  --exclude='.account_id' \
  --exclude='.env' --exclude='.env.*' \
  --exclude='*credentials*' \
  --exclude='*.pem' \
  --exclude='*.log' --exclude='log.txt' \
  --exclude='*.bak' --exclude='*.bak.*' \
  --exclude='*.swp' --exclude='.DS_Store' \
  --exclude='.claude' \
  --exclude='node_modules/' \
  --exclude='claude-robinhood-mcp/'

.PHONY: help pull push diff-pull diff-push save deploy gitpush check-secrets

help:
	@echo "make pull           # EC2  -> local   (bring server edits down)"
	@echo "make push           # local -> EC2    (send local edits up)"
	@echo "make diff-pull      # dry-run of pull (show what WOULD change)"
	@echo "make diff-push      # dry-run of push"
	@echo "make save msg='...' # pull from EC2, then git add + commit"
	@echo "make deploy         # push local to EC2"
	@echo "make gitpush        # secret-scan, then git push to GitHub"
	@echo "make check-secrets  # scan tracked files for secrets"

pull:
	$(RSYNC) $(EC2_HOST):$(REMOTE_DIR)/ $(LOCAL_DIR)/

push:
	$(RSYNC) $(LOCAL_DIR)/ $(EC2_HOST):$(REMOTE_DIR)/

diff-pull:
	$(RSYNC) --dry-run --itemize-changes $(EC2_HOST):$(REMOTE_DIR)/ $(LOCAL_DIR)/

diff-push:
	$(RSYNC) --dry-run --itemize-changes $(LOCAL_DIR)/ $(EC2_HOST):$(REMOTE_DIR)/

save: pull
	git add -A
	git commit -m "$(or $(msg),sync from EC2)"

deploy: push
	@echo "Local files pushed to EC2 ($(REMOTE_DIR))."

check-secrets:
	@ACCOUNT_ID="$(ACCOUNT_ID)" ./scripts/check-secrets.sh

gitpush: check-secrets
	git push
