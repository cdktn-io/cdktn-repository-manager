# The Future of Terraform CDK

> [!IMPORTANT]
>
> [OCF](https://the-ocf.org/) - [github.com/open-constructs](https://github.com/open-constructs) has stepped up to fork under the new name of [CDK Terrain - cdktn.io](https://cdktn.io)

# repository-manager

## About

This project handles repository management for the prebuilt Terraform provider packages and custom constructs that are published for use with [CDK Terrain (CDKTN)](https://github.com/open-constructs/cdk-terrain).

CDKTN allows you to use familiar programming languages to define cloud infrastructure and provision it through HashiCorp Terraform. This gives you access to the entire Terraform ecosystem without learning HashiCorp Configuration Language (HCL). Terraform providers can be generated locally to be used with your application, or installed via one of the prebuilt packages. We currently publish and maintain a small subset of prebuilt packages for the Terraform providers that currently have the highest usage in CDKTN apps. The current list of prebuilt provider packages can be found [here](https://github.com/hashicorp/cdktf-repository-manager/blob/main/provider.json).

## How we decide which providers to publish prebuilt packages for

Our current policy is as follows:

- We publish & maintain prebuilt packages for any providers labeled "[Official](https://registry.terraform.io/browse/providers?tier=official)" Or "[Partner](https://registry.terraform.io/browse/providers?tier=partner)" in the Terraform Registry _only_ upon explicit request by the technology partner (see below)
- We will not publish & maintain prebuilt packages for any providers labeled "[Community](https://registry.terraform.io/browse/providers?tier=community)" in the Terraform Registry.

### Information for HashiCorp Partners

We are currently prioritizing publishing a small subset of prebuilt provider packages, based on usage in existing CDKTF applications. If you are a current Hashicorp partner and you are interested in having a prebuilt package made available for your provider, please email [support@cdktn.io](mailto:support@cdktn.io) and also file an issue [here](https://github.com/cdktn-io/cdktn-repository-manager/issues/new?assignees=&labels=new+provider+request&projects=&template=request-provider.yml&title=New+Pre-built+Provider+Request%3A+PROVIDER_NAME).

## Development

### Local Setup

This repository uses CDKTF to manage GitHub repositories via Terraform. Before running Terraform commands locally, you need to set up authentication:

```bash
# Set GITHUB_TOKEN for Terraform provider authentication
export GITHUB_TOKEN=$(gh auth token)

# Verify your GitHub CLI token has required scopes
gh auth status
# Required scopes: repo, admin:org, workflow
```

### Building and Deploying

```bash
# Install dependencies
yarn install

# Build the project
yarn build

# Generate Terraform configuration
yarn synth

# Run Terraform commands
cd cdktf.out/stacks/repos
terraform init
terraform plan
terraform apply
```

### Fork and Import Workflow

If you're migrating repositories from the archived `cdktf` org to `cdktn-io`, use the fork-and-import script:

```bash
# Dry-run mode (preview what will happen)
node .github/lib/fork-and-import.js cdktf.out/stacks/repos

# Review the generated import.tf file
cat cdktf.out/stacks/repos/import.tf

# Execute the forks
node .github/lib/fork-and-import.js cdktf.out/stacks/repos --yes

# Import repos into Terraform state
cd cdktf.out/stacks/repos
terraform plan
terraform apply
```

For more details, see [plans/setup.md](plans/setup.md).
