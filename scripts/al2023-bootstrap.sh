#!/bin/bash
# Copyright IBM Corp. 2020, 2026
# SPDX-License-Identifier: MPL-2.0

# Bootstrap script for Amazon Linux 2023 (ARM64) to migrate large CDKTN provider repositories
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cdktn-io/cdktn-repository-manager/main/scripts/al2023-bootstrap.sh | bash
#
# Or download and run:
#   chmod +x al2023-bootstrap.sh
#   ./al2023-bootstrap.sh
#
# After running, authenticate with GitHub:
#   export GH_TOKEN="your_github_token"
#   gh auth login --with-token <<< "$GH_TOKEN"
#   gh auth status
#
# Then run the migration:
#   cd ~/cdktn-repository-manager
#   pnpm install && pnpm run build && pnpm run synth
#   USE_SSH=1 GITHUB_TOKEN=$(gh auth token) node .github/lib/fork-and-import.js cdktf.out/stacks/repos --only=cdktn-provider-aws --yes

set -euo pipefail

echo "=============================================="
echo "  CDKTN Repository Manager - EC2 Bootstrap"
echo "  Amazon Linux 2023 (ARM64)"
echo "=============================================="
echo ""

# Check if running on Amazon Linux 2023
if ! grep -q "Amazon Linux 2023" /etc/os-release 2>/dev/null; then
    echo "Warning: This script is designed for Amazon Linux 2023"
    echo "Continuing anyway..."
fi

# Install system dependencies
echo "Installing system dependencies..."
sudo dnf update -y
sudo dnf install -y git tar gzip unzip

# Fix gpg issue
sudo dnf install -y gnupg2 --allowerasing
export MISE_GPG=gpg2

# Install mise (formerly rtx) - handles node, terraform, gh, jq
echo ""
echo "Installing mise..."
if ! command -v mise &> /dev/null; then
    curl https://mise.run | sh

    # Add mise to shell
    echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
    export PATH="$HOME/.local/bin:$PATH"
    eval "$(~/.local/bin/mise activate bash)"
else
    echo "mise already installed"
fi

# Clone the repository
echo ""
echo "Cloning cdktn-repository-manager..."
cd ~
if [ -d "cdktn-repository-manager" ]; then
    echo "Repository already exists, pulling latest..."
    cd cdktn-repository-manager
    git pull
else
    git clone https://github.com/cdktn-io/cdktn-repository-manager.git
    cd cdktn-repository-manager
fi

# Install tools via mise (node, terraform, gh, jq)
echo ""
echo "Installing tools via mise (node, terraform, gh, jq)..."
~/.local/bin/mise install

# Verify installations
echo ""
echo "Verifying installations..."
~/.local/bin/mise ls

# Enable corepack (provides pnpm per the packageManager field in package.json)
echo ""
echo "Enabling corepack" # auto install pnpm, yarn, ...
# ensure node 20 is globally available
~/.local/bin/mise mise use -g node@20
corepack enable

# Set up SSH key for GitHub (optional but recommended for large repos)
echo ""
echo "Setting up SSH key for GitHub..."
if [ ! -f ~/.ssh/migration_key ]; then
    ssh-keygen -t ed25519 -C "ec2-migration" -f ~/.ssh/migration_key -N ""
    echo ""
    echo "SSH public key generated. Add this to your GitHub account:"
    echo "https://github.com/settings/ssh/new"
    echo ""
    cat ~/.ssh/migration_key.pub
    echo ""
else
    echo "SSH key already exists at ~/.ssh/migration_key"
fi

# Create SSH config for GitHub
if ! grep -q "Host github.com" ~/.ssh/config 2>/dev/null; then
    mkdir -p ~/.ssh
    cat >> ~/.ssh/config << 'EOF'
Host github.com
    IdentityFile ~/.ssh/migration_key
    IdentitiesOnly yes
EOF
    chmod 600 ~/.ssh/config
fi

# Start ssh-agent and add key
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/migration_key 2>/dev/null || true

echo ""
echo "=============================================="
echo "  Bootstrap Complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Authenticate with GitHub CLI:"
echo "   export GH_TOKEN=\"your_github_token_here\""
echo "   gh auth status"
echo ""
echo "2. Add the SSH key to GitHub via CLI (alternative to step 1):"
echo "   gh ssh-key add ~/.ssh/migration_key.pub --title \"EC2 Migration\""
echo ""
echo "3. Build the project:"
echo "   cd ~/cdktn-repository-manager"
echo "   pnpm install && pnpm run build && pnpm run synth"
echo ""
echo "4. Use Screen or Tmux:"
echo "   start:"
echo "     screen -S migration"
echo "   detatch: ctrl+a d"
echo "   list:"
echo "     screen -ls"
echo "   resume:"
echo "     screen -r migration"
echo ""
echo "5. Run the migration (for large providers like AWS):"
echo "   USE_SSH=1 GITHUB_TOKEN=\$(gh auth token) node .github/lib/fork-and-import.js \\"
echo "     cdktf.out/stacks/repos --only=cdktn-provider-aws --yes"
echo ""
echo "For more details, see: plans/large-providers.md"
echo ""
