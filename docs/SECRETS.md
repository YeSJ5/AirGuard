# Secret Management & Environment Security Policy

This document details the secret management structure for AirGuard, comparing local demonstration configuration with robust, enterprise-ready cloud practices.

---

## 1. Local Configuration & Multi-Environment Isolation

For local development and staging testing, configurations are driven by local `.env.<env>` files:
- `.env.dev`: Local container configurations, hot-reloads enabled.
- `.env.staging`: Strict replicas configuration mimicking production behavior but locally bound.
- `.env.prod`: Production simulation.

### Fail-Fast Startup Checks
The backend application utilizes a Pydantic `Settings` class to validate environment state on boot. In the `prod` environment, validation rules fail fast if:
1. `DATABASE_URL` contains `localhost` or `127.0.0.1`.
2. `REDIS_URL` contains `localhost` or `127.0.0.1`.
3. `SECRET_KEY` matches the default placeholder key (`SUPER_SECRET_TACTICAL_KEY_123!`).

If any check fails, Pydantic raises a `ValidationError` on startup, preventing the container from running in insecure configurations.

---

## 2. Production Security: Transitioning to Secrets Manager

Plaintext `.env` files are acceptable for local student demos because they are contained within developer filesystems and never checked into source control. However, in production, this is unacceptable due to several critical security risks:

| Security Vector | Plaintext `.env` Files | Cloud/Enterprise Secrets Managers |
| :--- | :--- | :--- |
| **Exposure Scope** | High. Secrets reside on container disk or environment, readable by anyone with read access to the namespace or server. | Low. Secrets are injected dynamically into memory, never written to disk or exposed in container specs. |
| **Audit Trails** | None. Reading a file leaves no log. | Complete access auditing. Log files record exactly which service requested which secret at what time. |
| **Rotation** | Hard. Requires rebuilds or rolling restarts of active containers. | Automated rotation. Services fetch fresh secrets on demand or via short-lived credentials. |
| **Access Control** | Coarse. If you have access to the file, you read all secrets. | Fine-grained IAM policies. An ingestion pod can read the OpenSky API token but is blocked from reading PostgreSQL credentials. |

---

## 3. Integration Implementations

### AWS Secrets Manager / GCP Secret Manager (Native Cloud Integration)
In AWS or GCP, secret retrieval is handled dynamically at container startup or runtime:
1. **IAM Role Binding**: Assign a service account or IAM Task Role to the container (e.g. ECS Task Role, Kubernetes Service Account with AWS IRSA / GCP Workload Identity).
2. **SDK Retrieval**: Refactor the application settings initializer to load secrets via HTTP APIs rather than env files:
   ```python
   # GCP Secret Manager Example
   from google.cloud import secretmanager
   
   def fetch_secret(secret_id: str) -> str:
       client = secretmanager.SecretManagerServiceClient()
       name = f"projects/my-gcp-project/secrets/{secret_id}/versions/latest"
       response = client.access_secret_version(request={"name": name})
       return response.payload.data.decode("UTF-8")
   ```
3. **Alternative (Kubernetes Secrets Store CSI Driver)**: Secrets are mounted directly as volume files or environment variables from external vaults dynamically at runtime, requiring zero application-level SDK changes.

### HashiCorp Vault Integration
1. **AppRole / K8s Auth**: The pod authenticates with Vault using a local service account token.
2. **Short-Lived Database Credentials**: Vault generates dynamic, temporary PostgreSQL database credentials valid for a short TTL (e.g. 1 hour), which the application refreshes dynamically before expiry. This eliminates static credential leakage risks entirely.
