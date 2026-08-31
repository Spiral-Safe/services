import { readKubernetesJWT, ServiceConfig } from "./config";

export interface TokenProvider {
  token(): Promise<string>;
  invalidate?(): void;
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly value: string) {}

  async token(): Promise<string> {
    return this.value;
  }
}

export class KubernetesTokenProvider implements TokenProvider {
  private cached?: { token: string; refreshAt: number };

  constructor(
    private readonly address: string,
    private readonly role: string,
    private readonly jwtPath: string,
    private readonly authPath: string,
    private readonly fetchImplementation: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.refreshAt > this.now()) {
      return this.cached.token;
    }
    const jwt = await readKubernetesJWT(this.jwtPath);
    const response = await this.fetchImplementation(
      `${this.address}/v1/${this.authPath}/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: this.role, jwt }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const body = await safeJSON(response);
    const token = body?.auth?.client_token;
    if (!response.ok || typeof token !== "string" || !token) {
      throw new Error(
        `Vault Kubernetes login failed with status ${response.status}`,
      );
    }
    const leaseSeconds = Number(body?.auth?.lease_duration);
    if (Number.isFinite(leaseSeconds) && leaseSeconds > 0) {
      const leaseMs = leaseSeconds * 1_000;
      const refreshSkewMs = Math.min(30_000, leaseMs / 5);
      this.cached = { token, refreshAt: this.now() + leaseMs - refreshSkewMs };
    } else {
      this.cached = undefined;
    }
    return token;
  }
}

export interface VaultEnvelope {
  data?: Record<string, unknown>;
  errors?: string[];
  [key: string]: unknown;
}

export class VaultResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly errors: string[],
  ) {
    super(errors[0] || `Vault request failed with status ${status}`);
  }
}

export class VaultClient {
  readonly tokenProvider: TokenProvider;

  constructor(
    private readonly config: ServiceConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
    tokenProvider?: TokenProvider,
  ) {
    if (tokenProvider) {
      this.tokenProvider = tokenProvider;
    } else if (config.vaultKubernetes) {
      this.tokenProvider = new KubernetesTokenProvider(
        config.vaultAddress,
        config.vaultKubernetes.role,
        config.vaultKubernetes.jwtPath,
        config.vaultKubernetes.authPath,
        fetchImplementation,
      );
    } else {
      this.tokenProvider = new StaticTokenProvider(config.vaultToken!);
    }
  }

  async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response = await this.request(path, body);
    if (response.status === 403 && this.tokenProvider.invalidate) {
      this.tokenProvider.invalidate();
      response = await this.request(path, body);
    }
    const envelope = await safeJSON(response);
    if (!response.ok) {
      const errors = Array.isArray(envelope?.errors)
        ? envelope.errors.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : [];
      throw new VaultResponseError(response.status, errors);
    }
    return envelope?.data && typeof envelope.data === "object"
      ? envelope.data
      : {};
  }

  async ready(): Promise<boolean> {
    await this.tokenProvider.token();
    const response = await this.fetchImplementation(
      `${this.config.vaultAddress}/v1/sys/health?standbyok=true&perfstandbyok=true`,
      { signal: AbortSignal.timeout(3_000) },
    );
    return [200, 429, 472, 473].includes(response.status);
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const token = await this.tokenProvider.token();
    return this.fetchImplementation(
      `${this.config.vaultAddress}/v1/spiral-safe/${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
  }
}

async function safeJSON(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
