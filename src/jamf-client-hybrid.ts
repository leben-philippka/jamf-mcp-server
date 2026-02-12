import axios, { AxiosInstance, AxiosError } from 'axios';
import { z } from 'zod';
import { createLogger } from './server/logger.js';
import { getDefaultAgentPool } from './utils/http-agent-pool.js';
import {
  JamfComputer,
  JamfComputerDetails,
  JamfSearchResponse,
  JamfApiResponse,
  JamfSearchCriteria,
  JamfScriptCreateInput,
  JamfScriptUpdateInput,
  JamfScriptDetails,
  JamfScriptParameters,
  JamfPackage,
} from './types/jamf-api.js';
import { isAxiosError, getErrorMessage, getAxiosErrorStatus, getAxiosErrorData } from './utils/type-guards.js';
import { CircuitBreaker, CircuitBreakerOptions } from './utils/retry.js';
import {
  normalizePolicyFrequency,
  normalizePolicyMinimumNetworkConnection,
  normalizePolicyNetworkRequirements,
  normalizePolicyXmlFrequencies,
  normalizeScriptPriority,
  normalizeSmartGroupCriterion,
} from './utils/jamf-normalize.js';

const logger = createLogger('jamf-client-hybrid');
const agentPool = getDefaultAgentPool();

type SmartGroupCriteriaInput = JamfSearchCriteria & {
  andOr?: 'and' | 'or';
  searchType?: string;
};

type SmartGroupCriteriaContainer = {
  criterion?: SmartGroupCriteriaInput[];
  criteria?: SmartGroupCriteriaInput[];
};

export interface JamfApiClientConfig {
  baseUrl: string;
  // OAuth2 credentials (for Modern API)
  clientId?: string;
  clientSecret?: string;
  // Basic Auth credentials (for getting Bearer token)
  username?: string;
  password?: string;
  readOnlyMode?: boolean;
  // TLS/SSL options
  rejectUnauthorized?: boolean; // Default: true for security
  // Note: Set to false only for development/testing with self-signed certificates
  // Circuit breaker options
  circuitBreaker?: {
    /** Enable circuit breaker (default: false) */
    enabled?: boolean;
    /** Number of failures before opening circuit (default: 5) */
    failureThreshold?: number;
    /** Time in ms to wait before trying again (default: 60000) */
    resetTimeout?: number;
    /** Number of successful requests in half-open to close (default: 3) */
    halfOpenRequests?: number;
  };
}

export interface JamfAuthToken {
  token: string;
  expires: Date;
  /** Timestamp when the token was issued */
  issuedAt: Date;
  /** Token lifetime in seconds as reported by the server */
  expiresIn: number;
}

/** Buffer time in milliseconds to refresh token before actual expiration */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiration
const POLICY_MAINTENANCE_FIELDS = [
  'recon',
  'reset_name',
  'install_all_cached_packages',
  'heal',
  'prebindings',
  'permissions',
  'byhost',
  'system_cache',
  'user_cache',
  'verify',
] as const;

// Computer schemas (same as unified client)
const ComputerSchema = z.object({
  id: z.string(),
  name: z.string(),
  udid: z.string(),
  serialNumber: z.string(),
  lastContactTime: z.string().optional(),
  lastReportDate: z.string().optional(),
  osVersion: z.string().optional(),
  ipAddress: z.string().optional(),
  macAddress: z.string().optional(),
  assetTag: z.string().optional(),
  modelIdentifier: z.string().optional(),
});

export type Computer = z.infer<typeof ComputerSchema>;

/**
 * Hybrid Jamf API Client that uses the correct authentication methods:
 * 1. OAuth2 client credentials for Modern API token
 * 2. Basic Auth to get Bearer token (which works on Classic API)
 * 3. Intelligent fallback to whichever method works
 */
export class JamfApiClientHybrid {
  private axiosInstance: AxiosInstance;
  private oauth2Token: JamfAuthToken | null = null;
  private bearerToken: JamfAuthToken | null = null;
  private basicAuthHeader: string | null = null;
  private _readOnlyMode: boolean;
  private config: JamfApiClientConfig;

  // Capabilities flags
  private hasOAuth2: boolean;
  private hasBasicAuth: boolean;
  private oauth2Available: boolean = false;
  private bearerTokenAvailable: boolean = false;

  // Cache
  private cachedSearchId: number | null = null;

  // Circuit breaker for API calls
  private circuitBreaker: CircuitBreaker | null = null;
  private circuitBreakerEnabled: boolean = false;
  private readonly policyWriteLocks: Map<string, Promise<void>> = new Map();

  private async sleep(ms: number): Promise<void> {
    const waitMs = Number(ms);
    if (!Number.isFinite(waitMs) || waitMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private async with409Retry<T>(
    fn: () => Promise<T>,
    ctx: { operation: string; resourceType?: string; resourceId?: string }
  ): Promise<T> {
    // Jamf Pro sometimes returns 409 when an admin has the object open in the UI or when an edit lock is held.
    // Retrying helps for transient locks, but won't help if someone is actively editing.
    const maxAttempts = Math.max(1, Number(process.env.JAMF_CONFLICT_RETRY_MAX ?? 3));
    const baseDelayMs = Math.max(0, Number(process.env.JAMF_CONFLICT_RETRY_DELAY_MS ?? 800));

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const status = getAxiosErrorStatus(err);
        if (status !== 409 || attempt >= maxAttempts) throw err;

        const jitter = Math.floor(Math.random() * 250);
        const waitMs = baseDelayMs * attempt + jitter;
        logger.warn('Received 409 Conflict from Jamf; retrying after backoff', {
          ...ctx,
          attempt,
          maxAttempts,
          waitMs,
        });
        await this.sleep(waitMs);
      }
    }

    // Defensive: should never reach here.
    throw lastError instanceof Error ? lastError : new Error('Request failed after retries');
  }

  private async withPolicyWriteLock<T>(policyId: string, fn: () => Promise<T>): Promise<T> {
    const key = String(policyId);
    const previous = this.policyWriteLocks.get(key) ?? Promise.resolve();

    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.then(() => current);
    this.policyWriteLocks.set(key, queued);

    await previous;
    try {
      return await fn();
    } finally {
      releaseCurrent();
      if (this.policyWriteLocks.get(key) === queued) {
        this.policyWriteLocks.delete(key);
      }
    }
  }

  constructor(config: JamfApiClientConfig) {
    this.config = config;
    this._readOnlyMode = config.readOnlyMode ?? false;

    // Guardrail: In MCP mode, default to read-only unless explicitly enabled.
    // This prevents accidental writes in production environments.
    const isMcpMode = process.env.MCP_MODE === 'true' || process.argv.includes('--mcp');
    const writeEnabled = process.env.JAMF_WRITE_ENABLED === 'true';
    if (isMcpMode && !writeEnabled) {
      this._readOnlyMode = true;
    }
    
    // Check available auth methods
    this.hasOAuth2 = !!(config.clientId && config.clientSecret);
    this.hasBasicAuth = !!(config.username && config.password);
    
    if (!this.hasOAuth2 && !this.hasBasicAuth) {
      throw new Error('No authentication credentials provided. Need either OAuth2 (clientId/clientSecret) or Basic Auth (username/password)');
    }
    
    // Store Basic Auth header for Classic API
    if (this.hasBasicAuth) {
      this.basicAuthHeader = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    }

    // Initialize circuit breaker if enabled
    if (config.circuitBreaker?.enabled) {
      this.circuitBreakerEnabled = true;
      this.circuitBreaker = new CircuitBreaker({
        failureThreshold: config.circuitBreaker.failureThreshold ?? 5,
        resetTimeout: config.circuitBreaker.resetTimeout ?? 60000,
        halfOpenRequests: config.circuitBreaker.halfOpenRequests ?? 3,
      });
      logger.info('Circuit breaker enabled', {
        failureThreshold: config.circuitBreaker.failureThreshold ?? 5,
        resetTimeout: config.circuitBreaker.resetTimeout ?? 60000,
        halfOpenRequests: config.circuitBreaker.halfOpenRequests ?? 3,
      });
    }

    // Initialize axios instance
    this.axiosInstance = axios.create({
      baseURL: config.baseUrl,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
      httpsAgent: agentPool.getHttpsAgent(), // Use pooled agent
    });
    
    // Add request interceptor to handle auth based on endpoint
    this.axiosInstance.interceptors.request.use((config) => {
      const requestMethod = String(config.method ?? 'get').toLowerCase();

      // Classic API endpoints - try Bearer token first, fallback to Basic auth
      if (config.url?.includes('/JSSResource/')) {
        // Try Bearer token first (some Jamf environments require this)
        if (this.bearerTokenAvailable && this.bearerToken) {
          config.headers['Authorization'] = `Bearer ${this.bearerToken.token}`;
          logger.info(`  🔑 Setting Bearer token for Classic API endpoint: ${config.url}`);
        } else if (this.oauth2Available && this.oauth2Token) {
          // Many Jamf tenants accept OAuth2 access tokens for Classic API as well.
          config.headers['Authorization'] = `Bearer ${this.oauth2Token.token}`;
          logger.info(`  🔑 Setting OAuth2 Bearer token for Classic API endpoint: ${config.url}`);
        } else if (this.basicAuthHeader) {
          config.headers['Authorization'] = this.basicAuthHeader;
          logger.info(`  🔑 Setting Basic Auth for Classic API endpoint: ${config.url}`);
        } else {
          logger.warn(`Classic API endpoint ${config.url} requested but no auth credentials available`);
        }

        // Reduce stale-read risk across Classic reads by forcing cache bypass headers
        // and a request-unique query marker.
        if (requestMethod === 'get') {
          config.headers = config.headers ?? {};
          if ((config.headers as any)['Cache-Control'] === undefined) {
            (config.headers as any)['Cache-Control'] = 'no-cache';
          }
          if ((config.headers as any).Pragma === undefined) {
            (config.headers as any).Pragma = 'no-cache';
          }

          const currentParams =
            config.params && typeof config.params === 'object' && !Array.isArray(config.params)
              ? config.params
              : {};
          if ((currentParams as any)._ts === undefined) {
            config.params = { ...currentParams, _ts: Date.now() };
          }
        }

        // Note: We keep Accept as application/json for Classic API
        // Jamf Classic API can return JSON if Accept header is set to application/json
      } else {
        // Modern API endpoints:
        // Prefer OAuth2 client-credentials token if configured, since it is the
        // intended Modern API auth method and may differ in permissions from a
        // Basic-derived bearer token.
        if (this.oauth2Available && this.oauth2Token) {
          config.headers['Authorization'] = `Bearer ${this.oauth2Token.token}`;
        } else if (this.bearerTokenAvailable && this.bearerToken) {
          config.headers['Authorization'] = `Bearer ${this.bearerToken.token}`;
        }
      }
      return config;
    });

    // Add response interceptor to handle 401 errors and re-authenticate
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as AxiosError['config'] & {
          _retry?: boolean;
          _retryBasicAuth?: boolean;
        };

        const isClassicEndpoint = Boolean(originalRequest?.url?.includes('/JSSResource/'));

        // Only retry on 401 and if we haven't already retried
        if (error.response?.status === 401 && originalRequest) {
          // Some Jamf tenants reject Bearer tokens for certain Classic endpoints (especially writes),
          // while still accepting Basic auth. If we have Basic configured and we just tried Bearer,
          // retry once with Basic before forcing a token refresh flow.
          const authHeader =
            (originalRequest.headers as any)?.Authorization ?? (originalRequest.headers as any)?.authorization;
          if (
            isClassicEndpoint &&
            this.basicAuthHeader &&
            typeof authHeader === 'string' &&
            authHeader.startsWith('Bearer ') &&
            !originalRequest._retryBasicAuth
          ) {
            originalRequest._retryBasicAuth = true;
            (originalRequest.headers as any).Authorization = this.basicAuthHeader;
            logger.info('Classic endpoint returned 401 with Bearer auth; retrying once with Basic auth', {
              url: originalRequest.url,
            });
            return this.axiosInstance(originalRequest);
          }

          // Token refresh retry (once per request).
          if (originalRequest._retry) {
            return Promise.reject(error);
          }

          originalRequest._retry = true;

          logger.info('Received 401 Unauthorized, attempting to refresh token...');

          // Invalidate current tokens to force refresh
          this.bearerTokenAvailable = false;
          this.oauth2Available = false;
          this.bearerToken = null;
          this.oauth2Token = null;

          try {
            // Re-authenticate
            await this.ensureAuthenticated();

            // Update Authorization header with fresh token
            this.updateAuthorizationHeader(originalRequest);

            logger.info('Token refreshed successfully, retrying original request');
            return this.axiosInstance(originalRequest);
          } catch (refreshError) {
            logger.error('Failed to refresh token after 401', {
              error: refreshError instanceof Error ? refreshError.message : String(refreshError),
            });
            return Promise.reject(error);
          }
        }

        return Promise.reject(error);
      }
    );

    // MCP servers must not output to stdout/stderr - commenting out logger
    // logger.info(`Jamf Hybrid Client initialized with:`);
    // logger.info(`  - OAuth2 (Client Credentials): ${this.hasOAuth2 ? 'Available' : 'Not configured'}`);
    // logger.info(`  - Basic Auth (Bearer Token): ${this.hasBasicAuth ? 'Available' : 'Not configured'}`);
  }

  /**
   * Check if the client is in read-only mode
   */
  get readOnlyMode(): boolean {
    return this._readOnlyMode;
  }

  /**
   * Get token status information for health checks and debugging
   */
  getTokenStatus(): {
    bearerToken: { available: boolean; issuedAt?: Date; expiresAt?: Date; expiresIn?: number } | null;
    oauth2Token: { available: boolean; issuedAt?: Date; expiresAt?: Date; expiresIn?: number } | null;
    hasBasicAuth: boolean;
    hasOAuth2: boolean;
  } {
    return {
      bearerToken: this.bearerToken
        ? {
            available: this.bearerTokenAvailable,
            issuedAt: this.bearerToken.issuedAt,
            expiresAt: this.bearerToken.expires,
            expiresIn: this.bearerToken.expiresIn,
          }
        : null,
      oauth2Token: this.oauth2Token
        ? {
            available: this.oauth2Available,
            issuedAt: this.oauth2Token.issuedAt,
            expiresAt: this.oauth2Token.expires,
            expiresIn: this.oauth2Token.expiresIn,
          }
        : null,
      hasBasicAuth: this.hasBasicAuth,
      hasOAuth2: this.hasOAuth2,
    };
  }

  /**
   * Get circuit breaker status for health checks
   */
  getCircuitBreakerStatus(): {
    enabled: boolean;
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'DISABLED';
    failureCount: number;
    config: {
      failureThreshold: number;
      resetTimeout: number;
      halfOpenRequests: number;
    } | null;
  } {
    if (!this.circuitBreakerEnabled || !this.circuitBreaker) {
      return {
        enabled: false,
        state: 'DISABLED',
        failureCount: 0,
        config: null,
      };
    }

    return {
      enabled: true,
      state: this.circuitBreaker.getState() as 'CLOSED' | 'OPEN' | 'HALF_OPEN',
      failureCount: this.circuitBreaker.getFailureCount(),
      config: {
        failureThreshold: this.config.circuitBreaker?.failureThreshold ?? 5,
        resetTimeout: this.config.circuitBreaker?.resetTimeout ?? 60000,
        halfOpenRequests: this.config.circuitBreaker?.halfOpenRequests ?? 3,
      },
    };
  }

  /**
   * Get non-sensitive auth status for debugging
   */
  getAuthStatus(): {
    hasOAuth2: boolean;
    hasBasicAuth: boolean;
    oauth2Available: boolean;
    bearerTokenAvailable: boolean;
    readOnlyMode: boolean;
    mcpModeDetected: boolean;
    writeEnabled: boolean;
    oauth2: { issuedAt?: Date; expiresAt?: Date; expiresIn?: number } | null;
    bearer: { issuedAt?: Date; expiresAt?: Date; expiresIn?: number } | null;
  } {
    const mcpModeDetected = process.env.MCP_MODE === 'true' || process.argv.includes('--mcp');
    const writeEnabled = process.env.JAMF_WRITE_ENABLED === 'true';
    return {
      hasOAuth2: this.hasOAuth2,
      hasBasicAuth: this.hasBasicAuth,
      oauth2Available: this.oauth2Available,
      bearerTokenAvailable: this.bearerTokenAvailable,
      readOnlyMode: this._readOnlyMode,
      mcpModeDetected,
      writeEnabled,
      oauth2: this.oauth2Token
        ? {
            issuedAt: this.oauth2Token.issuedAt,
            expiresAt: this.oauth2Token.expires,
            expiresIn: this.oauth2Token.expiresIn,
          }
        : null,
      bearer: this.bearerToken
        ? {
            issuedAt: this.bearerToken.issuedAt,
            expiresAt: this.bearerToken.expires,
            expiresIn: this.bearerToken.expiresIn,
          }
        : null,
    };
  }

  private canCallClassicApi(): boolean {
    // Classic API calls require either a bearer token (minted via Basic auth) or Basic auth directly.
    return (
      Boolean(this.bearerTokenAvailable && this.bearerToken) ||
      Boolean(this.oauth2Available && this.oauth2Token) ||
      Boolean(this.basicAuthHeader)
    );
  }

  private shouldFallbackToClassicOnModernError(
    error: unknown,
    opts?: { allowOn403?: boolean }
  ): boolean {
    if (!this.canCallClassicApi()) return false;

    const status = getAxiosErrorStatus(error);
    if (!status) return false;

    // Never mask caller errors.
    if (status === 400 || status === 401) return false;

    // Optional: some read-only resources are available in Classic but forbidden in Modern for a given token.
    if (status === 403) return Boolean(opts?.allowOn403);

    // Endpoint unavailable in this Jamf Pro version.
    if (status === 404 || status === 405 || status === 501) return true;

    // Server errors: Modern can be flaky while Classic still works.
    if (status >= 500 && status <= 599) return true;

    return false;
  }

  private isClassicPolicyPayload(policyData: any): boolean {
    if (!policyData || typeof policyData !== 'object') return false;
    // Classic policy payloads are generally nested and match /JSSResource/policies XML structure.
    return Boolean(
      policyData.general ||
        policyData.scope ||
        policyData.self_service ||
        policyData.maintenance ||
        policyData.package_configuration ||
        policyData.scripts
    );
  }

  async createPolicyXml(policyXml: string): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create policies in read-only mode');
    }
    await this.ensureAuthenticated();

    const xmlPayload = normalizePolicyXmlFrequencies(String(policyXml));
    const response = await this.axiosInstance.post(
      '/JSSResource/policies/id/0',
      xmlPayload,
      {
        headers: {
          'Content-Type': 'application/xml',
          'Accept': 'application/xml',
        },
      }
    );

    const locationHeader = response.headers.location;
    const policyId = locationHeader ? locationHeader.split('/').pop() : null;
    if (policyId) {
      return await this.getPolicyDetails(policyId);
    }
    return { success: true };
  }

  async updatePolicyXml(
    policyId: string,
    policyXml: string,
    options?: { skipPolicyWriteLock?: boolean }
  ): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update policies in read-only mode');
    }
    await this.ensureAuthenticated();

    const run = async (): Promise<any> => {
      const xmlPayload = normalizePolicyXmlFrequencies(String(policyXml));
      await this.with409Retry(
        async () =>
          await this.axiosInstance.put(
            `/JSSResource/policies/id/${policyId}`,
            xmlPayload,
            {
              headers: {
                'Content-Type': 'application/xml',
                'Accept': 'application/xml',
              },
            }
          ),
        { operation: 'updatePolicyXml', resourceType: 'policy', resourceId: String(policyId) }
      );

      return await this.getPolicyDetails(policyId);
    };

    if (options?.skipPolicyWriteLock) {
      return await run();
    }
    return await this.withPolicyWriteLock(policyId, run);
  }

  /**
   * Execute a function through the circuit breaker if enabled
   * Otherwise, execute directly
   */
  private async executeWithCircuitBreaker<T>(fn: () => Promise<T>): Promise<T> {
    if (this.circuitBreakerEnabled && this.circuitBreaker) {
      return this.circuitBreaker.execute(fn);
    }
    return fn();
  }

  /**
   * Make a GET request through the circuit breaker
   */
  private async protectedGet<T = unknown>(url: string, config?: Parameters<AxiosInstance['get']>[1]): Promise<T> {
    return this.executeWithCircuitBreaker(async () => {
      const response = await this.axiosInstance.get<T>(url, config);
      return response.data;
    });
  }

  /**
   * Make a POST request through the circuit breaker
   */
  private async protectedPost<T = unknown>(
    url: string,
    data?: unknown,
    config?: Parameters<AxiosInstance['post']>[2]
  ): Promise<T> {
    return this.executeWithCircuitBreaker(async () => {
      const response = await this.axiosInstance.post<T>(url, data, config);
      return response.data;
    });
  }

  /**
   * Make a PUT request through the circuit breaker
   */
  private async protectedPut<T = unknown>(
    url: string,
    data?: unknown,
    config?: Parameters<AxiosInstance['put']>[2]
  ): Promise<T> {
    return this.executeWithCircuitBreaker(async () => {
      const response = await this.axiosInstance.put<T>(url, data, config);
      return response.data;
    });
  }

  /**
   * Make a DELETE request through the circuit breaker
   */
  private async protectedDelete<T = unknown>(url: string, config?: Parameters<AxiosInstance['delete']>[1]): Promise<T> {
    return this.executeWithCircuitBreaker(async () => {
      const response = await this.axiosInstance.delete<T>(url, config);
      return response.data;
    });
  }

  /**
   * Update the Authorization header on a request config with the current token
   * This is extracted to a separate method to avoid TypeScript control flow issues
   */
  private updateAuthorizationHeader(config: { headers?: Record<string, unknown>; url?: string }): void {
    if (!config.headers) return;

    if (this.oauth2Available && this.oauth2Token) {
      config.headers['Authorization'] = `Bearer ${this.oauth2Token.token}`;
    } else if (this.bearerTokenAvailable && this.bearerToken) {
      config.headers['Authorization'] = `Bearer ${this.bearerToken.token}`;
    } else if (this.basicAuthHeader && config.url?.includes('/JSSResource/')) {
      config.headers['Authorization'] = this.basicAuthHeader;
    }
  }

  /**
   * Get OAuth2 token using client credentials flow
   */
  private async getOAuth2Token(): Promise<void> {
    if (!this.hasOAuth2) return;
    
    try {
      const params = new URLSearchParams({
        'grant_type': 'client_credentials',
        'client_id': this.config.clientId!,
        'client_secret': this.config.clientSecret!
      });

      const response = await axios.post(
        `${this.config.baseUrl}/api/oauth/token`,
        params,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          httpsAgent: agentPool.getHttpsAgent(), // Use pooled agent
        }
      );

      // Default to 20 minutes if expires_in not provided
      const expiresInSeconds = response.data.expires_in ?? 20 * 60;
      const issuedAt = new Date();

      this.oauth2Token = {
        token: response.data.access_token,
        expires: new Date(issuedAt.getTime() + expiresInSeconds * 1000),
        issuedAt,
        expiresIn: expiresInSeconds,
      };
      
      this.oauth2Available = true;
      logger.info('✅ OAuth2 token obtained successfully');
    } catch (error) {
      logger.warn('OAuth2 authentication failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      this.oauth2Available = false;
    }
  }

  /**
   * Get Bearer token using Basic Auth credentials
   */
  private async getBearerTokenWithBasicAuth(): Promise<void> {
    if (!this.hasBasicAuth) return;
    
    try {
      const response = await axios.post(
        `${this.config.baseUrl}/api/v1/auth/token`,
        null,
        {
          headers: {
            'Authorization': this.basicAuthHeader!,
            'Accept': 'application/json',
          },
          httpsAgent: agentPool.getHttpsAgent(), // Use pooled agent
        }
      );

      // Parse expires from response if available, otherwise default to 30 minutes (Jamf default)
      const expiresInSeconds = response.data.expires ?? 30 * 60;
      const issuedAt = new Date();

      this.bearerToken = {
        token: response.data.token,
        expires: new Date(issuedAt.getTime() + expiresInSeconds * 1000),
        issuedAt,
        expiresIn: expiresInSeconds,
      };
      
      this.bearerTokenAvailable = true;
      logger.info('✅ Bearer token obtained using Basic Auth');
    } catch (error) {
      logger.warn('Basic Auth to Bearer token failed', { 
        error: error instanceof Error ? error.message : String(error) 
      });
      this.bearerTokenAvailable = false;
    }
  }

  /**
   * Check if a token is expired or will expire soon (within buffer time)
   */
  private isTokenExpiredOrExpiring(token: JamfAuthToken | null): boolean {
    if (!token) return true;
    const bufferTime = new Date(Date.now() + TOKEN_REFRESH_BUFFER_MS);
    return token.expires <= bufferTime;
  }

  /**
   * Ensure we have a valid token, refreshing proactively before expiration
   */
  private async ensureAuthenticated(): Promise<void> {
    // Refresh both auth methods independently if configured.
    // This prevents "Basic-derived bearer token" from shadowing OAuth2 on Modern endpoints.
    if (this.hasBasicAuth && this.isTokenExpiredOrExpiring(this.bearerToken)) {
      logger.debug('Bearer token expired or expiring soon, refreshing...', {
        expires: this.bearerToken?.expires,
        issuedAt: this.bearerToken?.issuedAt,
        expiresIn: this.bearerToken?.expiresIn,
      });
      await this.getBearerTokenWithBasicAuth();
    }

    if (this.hasOAuth2 && this.isTokenExpiredOrExpiring(this.oauth2Token)) {
      logger.debug('OAuth2 token expired or expiring soon, refreshing...', {
        expires: this.oauth2Token?.expires,
        issuedAt: this.oauth2Token?.issuedAt,
        expiresIn: this.oauth2Token?.expiresIn,
      });
      await this.getOAuth2Token();
    }

    // We don't set headers here anymore - the interceptor handles it based on the endpoint
    // Just ensure we have at least one valid auth method
    if (!this.bearerTokenAvailable && !this.oauth2Available) {
      throw new Error('No valid authentication method available');
    }
  }

  /**
   * Test which APIs are accessible
   */
  async testApiAccess(): Promise<void> {
    await this.ensureAuthenticated();
    
    logger.info('\nTesting API access:');
    
    // Test Modern API
    try {
      await this.axiosInstance.get('/api/v1/auth');
      logger.info('  ✅ Modern API: Accessible');
    } catch (error) {
      logger.warn('Modern API not accessible', { 
        error: error instanceof Error ? error.message : String(error),
        endpoint: '/api/v1/jamf-pro-server-url'
      });
    }
    
    // Test Classic API
    try {
      logger.info(`  Testing Classic API with Basic Auth: ${this.hasBasicAuth ? 'Available' : 'Not configured'}`);
      const response = await this.axiosInstance.get('/JSSResource/categories');
      logger.info('  ✅ Classic API: Accessible');
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.warn('Classic API not accessible', {
        error: error instanceof Error ? error.message : String(error),
        endpoint: '/JSSResource/categories',
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        hasBasicAuth: this.hasBasicAuth,
        responseData: axiosError.response?.data
      });
    }
  }

  /**
   * Transform Classic API computer to standard format
   */
  private transformClassicComputer(classicComputer: JamfComputer): Computer {
    return {
      id: String(classicComputer.id),
      name: classicComputer.name || '',
      udid: classicComputer.udid || '',
      serialNumber: classicComputer.serial_number || '',
      lastContactTime: classicComputer.last_contact_time,
      lastReportDate: classicComputer.report_date,
      osVersion: classicComputer.os_version,
      ipAddress: classicComputer.ip_address,
      macAddress: classicComputer.mac_address,
      assetTag: classicComputer.asset_tag,
      modelIdentifier: classicComputer.model_identifier,
    };
  }

  private normalizeClassicCategoryList(payload: any): Array<{ id: number; name: string; priority?: number }> {
    const raw = payload?.categories ?? payload?.category ?? payload;
    if (!raw) return [];

    // Common shapes:
    // 1) { categories: [ { id, name }, ... ] }
    // 2) { categories: [ { category: { id, name, priority } }, ... ] } (OpenAPI sample)
    // 3) { categories: { category: [ ... ] } }
    const arr: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.category)
        ? raw.category
        : raw?.category
          ? [raw.category]
          : [];

    const out: Array<{ id: number; name: string; priority?: number }> = [];
    for (const item of arr) {
      const c = item?.category ?? item;
      const id = Number(c?.id);
      const name = typeof c?.name === 'string' ? c.name : '';
      const priority = c?.priority !== undefined ? Number(c.priority) : undefined;
      if (Number.isFinite(id) && id > 0 && name) out.push({ id, name, ...(Number.isFinite(priority) ? { priority } : {}) });
    }
    return out;
  }

  async listCategories(): Promise<Array<{ id: number; name: string; priority?: number }>> {
    await this.ensureAuthenticated();

    // Modern API categories exist, but Classic is widely available and simple.
    try {
      const modern = await this.axiosInstance.get('/api/v1/categories', {
        params: { page: 0, 'page-size': 2000 },
      });
      const results: any[] = modern.data?.results ?? modern.data ?? [];
      if (Array.isArray(results) && results.length > 0) {
        return results
          .map((c: any) => ({
            id: Number(c.id),
            name: String(c.name ?? ''),
            priority: c.priority !== undefined ? Number(c.priority) : undefined,
          }))
          .filter((c) => Number.isFinite(c.id) && c.id > 0 && Boolean(c.name));
      }
    } catch (error) {
      // allow Classic fallback
      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
    }

    const classic = await this.axiosInstance.get('/JSSResource/categories');
    return this.normalizeClassicCategoryList(classic.data);
  }

  async getCategoryByName(name: string): Promise<{ id: number; name: string; priority?: number } | null> {
    await this.ensureAuthenticated();

    const target = String(name ?? '').trim();
    if (!target) return null;

    // Classic API supports /categories/name/{name}
    try {
      const response = await this.axiosInstance.get(`/JSSResource/categories/name/${encodeURIComponent(target)}`);
      const c = response.data?.category ?? response.data;
      const id = Number(c?.id);
      const nm = typeof c?.name === 'string' ? c.name : '';
      const pr = c?.priority !== undefined ? Number(c.priority) : undefined;
      if (Number.isFinite(id) && id > 0 && nm) return { id, name: nm, ...(Number.isFinite(pr) ? { priority: pr } : {}) };
    } catch (error) {
      // fallback to list below
      logger.info('Classic getCategoryByName failed; falling back to listCategories', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
    }

    const all = await this.listCategories();
    const lower = target.toLowerCase();
    const match = all.find((c) => c.name.toLowerCase() === lower);
    return match ?? null;
  }

  private buildCategoryXml(input: { name: string; priority?: number }): string {
    const name = String(input.name ?? '').trim();
    const priority = input.priority;

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<category>\n';
    xml += `  <name>${this.escapeXml(name)}</name>\n`;
    if (priority !== undefined && priority !== null && Number.isFinite(Number(priority))) {
      xml += `  <priority>${this.escapeXml(String(priority))}</priority>\n`;
    }
    xml += '</category>';
    return xml;
  }

  async createCategory(input: { name: string; priority?: number }): Promise<{ id: number; name: string; priority?: number }> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create categories in read-only mode');
    }
    await this.ensureAuthenticated();

    const name = String(input?.name ?? '').trim();
    if (!name) throw new Error('Category name is required');

    const existing = await this.getCategoryByName(name);
    if (existing) return existing;

    // Prefer Modern API when available (OAuth2-only deployments often cannot write to Classic for some resources).
    // We fall back to Classic XML if Modern is not supported or fails.
    try {
      const payload: Record<string, unknown> = { name };
      if (input?.priority !== undefined && input?.priority !== null && Number.isFinite(Number(input.priority))) {
        payload.priority = Number(input.priority);
      }

      const response = await this.axiosInstance.post('/api/v1/categories', payload);
      const id = Number((response.data as any)?.id ?? (response.data as any)?.categoryId);
      const nm = String((response.data as any)?.name ?? name).trim();
      const pr =
        (response.data as any)?.priority !== undefined ? Number((response.data as any).priority) : input?.priority;

      if (Number.isFinite(id) && id > 0) {
        return { id, name: nm || name, ...(Number.isFinite(Number(pr)) ? { priority: Number(pr) } : {}) };
      }
      // If Modern returns an unexpected shape, we still try Classic to be safe.
      logger.info('Modern createCategory returned unexpected shape; falling back to Classic API', {
        data: response.data,
      });
    } catch (error) {
      // Fall back to Classic for tenants without the endpoint or when Modern write permissions differ.
      logger.info('Modern createCategory failed; falling back to Classic API', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
    }

    const xmlPayload = this.buildCategoryXml({ name, priority: input?.priority });
    await this.with409Retry(
      async () =>
        await this.axiosInstance.post('/JSSResource/categories/id/0', xmlPayload, {
          headers: {
            'Content-Type': 'application/xml',
            'Accept': 'application/xml',
          },
        }),
      { operation: 'createCategory', resourceType: 'category', resourceId: name }
    );

    const created = await this.getCategoryByName(name);
    if (!created) {
      // Best-effort: list and match.
      const all = await this.listCategories();
      const lower = name.toLowerCase();
      const match = all.find((c) => c.name.toLowerCase() === lower);
      if (match) return match;
      throw new Error('Category was created but could not be fetched by name');
    }
    return created;
  }

  async ensureSelfServiceCategoryExists(input: { name: string; priority?: number }): Promise<{ category: { id: number; name: string; priority?: number }; created: boolean }> {
    const name = String(input?.name ?? '').trim();
    if (!name) throw new Error('Category name is required');

    const existing = await this.getCategoryByName(name);
    if (existing) return { category: existing, created: false };

    const created = await this.createCategory({ name, priority: input?.priority });
    return { category: created, created: true };
  }

  /**
   * Search computers
   */
  async searchComputers(query: string, limit: number = 100): Promise<Computer[]> {
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info('Searching computers using Modern API...');
      const params: Record<string, string | number> = {
        'page-size': limit,
      };
      
      // Only add filter if there's a query
      if (query && query.trim() !== '') {
        // Try simpler filter syntax
        params.filter = `general.name=="*${query}*"`;
      }
      
      const response = await this.axiosInstance.get('/api/v1/computers-inventory', {
        params,
      });
      
      // Transform modern response
      return response.data.results.map((computer: any) => ({
        id: computer.id,
        name: computer.general?.name || '',
        udid: computer.general?.udid || '',
        serialNumber: computer.general?.serialNumber || '',
        lastContactTime: computer.general?.lastContactTime,
        lastReportDate: computer.general?.lastReportDate,
        osVersion: computer.operatingSystem?.version,
        ipAddress: computer.general?.lastIpAddress,
        macAddress: computer.general?.macAddress,
        assetTag: computer.general?.assetTag,
        modelIdentifier: computer.hardware?.modelIdentifier,
      }));
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 403) {
        logger.info('Modern API search returned 403, trying Classic API...');
      } else {
        logger.debug('Modern API search failed, falling back to Classic API', {
          error: error instanceof Error ? error.message : String(error),
          status: axiosError.response?.status
        });
      }
    }
    
    // Try Classic API
    try {
      logger.info('Searching computers using Classic API...');
      if (query) {
        const response = await this.axiosInstance.get(`/JSSResource/computers/match/*${query}*`);
        const computers = response.data.computers || [];
        return computers.slice(0, limit).map((c: any) => this.transformClassicComputer(c));
      } else {
        const response = await this.axiosInstance.get('/JSSResource/computers');
        const computers = response.data.computers || [];
        return computers.slice(0, limit).map((c: any) => this.transformClassicComputer(c));
      }
    } catch (error) {
      logger.info('Classic API search failed:', error);
    }
    
    // Fall back to Advanced Search
    logger.info('Falling back to Advanced Search...');
    return this.searchComputersViaAdvancedSearch(query, limit);
  }

  /**
   * Search computers via Advanced Search
   */
  private async searchComputersViaAdvancedSearch(query: string, limit: number): Promise<Computer[]> {
    const searchId = await this.findBestAdvancedSearch();
    
    const response = await this.axiosInstance.get(`/JSSResource/advancedcomputersearches/id/${searchId}`);
    const allComputers = response.data.advanced_computer_search?.computers || [];
    
    let filteredComputers = allComputers;
    if (query) {
      const lowerQuery = query.toLowerCase();
      filteredComputers = allComputers.filter((c: any) => {
        const searchableFields = [
          c.name, c.Computer_Name, c.Serial_Number, c.IP_Address
        ].filter(Boolean).map(f => f.toLowerCase());
        return searchableFields.some(field => field.includes(lowerQuery));
      });
    }
    
    return filteredComputers.slice(0, limit).map((c: any) => ({
      id: String(c.id),
      name: c.name || c.Computer_Name || '',
      udid: c.udid || '',
      serialNumber: c.Serial_Number || '',
      lastContactTime: c.Last_Check_in,
      lastReportDate: c.Last_Inventory_Update,
      osVersion: c.Operating_System_Version,
      ipAddress: c.IP_Address,
      macAddress: c.MAC_Address,
      assetTag: c.Asset_Tag,
      modelIdentifier: c.Model,
    }));
  }

  /**
   * Find the best Advanced Search to use
   */
  private async findBestAdvancedSearch(): Promise<number> {
    if (this.cachedSearchId) return this.cachedSearchId;
    
    const response = await this.axiosInstance.get('/JSSResource/advancedcomputersearches');
    const searches = response.data.advanced_computer_searches || [];
    
    // Look for searches with good names
    const candidateSearches = searches.filter((s: any) => 
      s.name.toLowerCase().includes('all') ||
      s.name.toLowerCase().includes('inventory') ||
      s.name.toLowerCase().includes('applications')
    );
    
    if (candidateSearches.length > 0) {
      this.cachedSearchId = Number(candidateSearches[0].id);
      logger.info(`Using Advanced Search: "${candidateSearches[0].name}" (ID: ${this.cachedSearchId})`);
      return this.cachedSearchId;
    }
    
    // Use first available search
    if (searches.length > 0) {
      this.cachedSearchId = Number(searches[0].id);
      logger.info(`Using first available Advanced Search: "${searches[0].name}" (ID: ${this.cachedSearchId})`);
      return this.cachedSearchId;
    }
    
    throw new Error('No advanced searches found');
  }

  /**
   * Get computer details
   */
  async getComputerDetails(id: string): Promise<any> {
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info(`Getting computer details for ${id} using Modern API...`);
      const response = await this.axiosInstance.get(`/api/v1/computers-inventory-detail/${id}`);
      return response.data;
    } catch (error) {
      logger.debug('Modern API computer details failed, falling back to Classic API', {
        status: getAxiosErrorStatus(error),
        error: error instanceof Error ? error.message : String(error),
        computerId: id
      });
      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
    }
    
    // Try Classic API
    logger.info(`Getting computer details for ${id} using Classic API...`);
    try {
      const response = await this.axiosInstance.get(`/JSSResource/computers/id/${id}`);
      return response.data.computer;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Failed to get computer details from both APIs', {
        computerId: id,
        error: error instanceof Error ? error.message : String(error),
        status: axiosError.response?.status
      });
      throw error;
    }
  }

  /**
   * Get per-computer policy execution logs ("Policy Logs") via Classic API computer history.
   *
   * Note: Jamf Pro's Modern API does not currently expose the same execution history the UI shows.
   * The Classic API provides this per computer via the computerhistory resource.
   */
  async getComputerPolicyLogs(params: { serialNumber?: string; deviceId?: string }): Promise<any> {
    await this.ensureAuthenticated();

    if (!this.canCallClassicApi()) {
      throw new Error('Classic API is not available with the current authentication configuration');
    }

    const serialNumber = params.serialNumber?.trim();
    const deviceId = params.deviceId?.trim();

    if (!serialNumber && !deviceId) {
      throw new Error('Either serialNumber or deviceId is required');
    }

    const subset = 'PolicyLogs';
    const endpoint = serialNumber
      ? `/JSSResource/computerhistory/serialnumber/${encodeURIComponent(serialNumber)}/subset/${subset}`
      : `/JSSResource/computerhistory/id/${encodeURIComponent(deviceId!)}/subset/${subset}`;

    logger.info('Getting computer policy logs via Classic API computerhistory', {
      serialNumber: serialNumber || undefined,
      deviceId: deviceId || undefined,
      endpoint,
    });

    const response = await this.axiosInstance.get(endpoint);
    return response.data;
  }

  /**
   * Get all computers (for compatibility)
   */
  async getAllComputers(limit: number = 1000): Promise<any[]> {
    const computers = await this.searchComputers('', limit);
    return computers.map(c => ({
      id: c.id,
      name: c.name,
      general: {
        name: c.name,
        serial_number: c.serialNumber,
        last_contact_time: c.lastContactTime,
        last_contact_time_utc: c.lastContactTime,
      }
    }));
  }

  // Keep-alive method
  async keepAlive(): Promise<void> {
    await this.ensureAuthenticated();
    
    // If using Bearer token from Basic Auth, we can refresh it
    if (this.bearerTokenAvailable && this.hasBasicAuth) {
      try {
        await this.axiosInstance.post('/api/v1/auth/keep-alive');
        logger.info('✅ Token refreshed');
      } catch (error) {
        // Re-authenticate if keep-alive fails
        await this.getBearerTokenWithBasicAuth();
      }
    }
  }

  // Execute policy (if not in read-only mode)
  async executePolicy(policyId: string, deviceIds: string[]): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot execute policies in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    for (const deviceId of deviceIds) {
      await this.axiosInstance.post(`/api/v1/policies/${policyId}/retry/${deviceId}`);
    }
  }

  // Deploy script (if not in read-only mode)
  async deployScript(scriptId: string, deviceIds: string[]): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot deploy scripts in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    for (const deviceId of deviceIds) {
      await this.axiosInstance.post(`/api/v1/scripts/${scriptId}/run`, {
        computerIds: [deviceId],
      });
    }
  }

  // Update inventory (if not in read-only mode)
  async updateInventory(deviceId: string): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update inventory in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      // Modern API uses management commands endpoint
      await this.axiosInstance.post(`/api/v1/jamf-management-framework/redeploy/${deviceId}`);
      logger.info(`Inventory update requested for device ${deviceId} via Modern API`);
    } catch (error) {
      const status = getAxiosErrorStatus(error);
      if ((status === 404 || status === 403) && this.canCallClassicApi()) {
        logger.info('Modern API failed, trying Classic API computercommands...');
        // Try Classic API using the correct endpoint
        try {
          await this.axiosInstance.post(`/JSSResource/computercommands/command/UpdateInventory`, {
            computer_id: deviceId,
          });
          logger.info(`Inventory update requested for device ${deviceId} via Classic API`);
        } catch (classicError) {
          logger.info('Classic API computercommands failed:', classicError);
          throw classicError;
        }
      } else {
        throw error;
      }
    }
  }

  // List policies
  async listPolicies(limit: number = 100): Promise<any[]> {
    await this.ensureAuthenticated();

    // Try Modern API first (v1)
    try {
      const response = await this.axiosInstance.get('/api/v1/policies', {
        params: {
          page: 0,
          'page-size': Math.min(limit, 2000),
        },
      });
      const policies = response.data.results || [];
      logger.info(`Retrieved ${policies.length} policies from Modern API`);
      return policies;
    } catch (modernError) {
      if (!this.shouldFallbackToClassicOnModernError(modernError, { allowOn403: true })) {
        throw modernError;
      }

      logger.info('Modern API not available for policies, trying Classic API', {
        status: getAxiosErrorStatus(modernError),
        data: getAxiosErrorData(modernError),
      });

      // Fallback to Classic API
      try {
        const response = await this.axiosInstance.get('/JSSResource/policies');
        const policies = response.data.policies || [];
        logger.info(`Retrieved ${policies.length} policies from Classic API`);
        return policies.slice(0, limit);
      } catch (classicError) {
        logger.warn('Failed to list policies from both Modern and Classic APIs', {
          modernError: modernError instanceof Error ? modernError.message : String(modernError),
          classicError: classicError instanceof Error ? classicError.message : String(classicError),
        });
        return [];
      }
    }
  }

  // Search policies
  async searchPolicies(query: string, limit: number = 100): Promise<any[]> {
    await this.ensureAuthenticated();
    
    try {
      // Get all policies and filter
      const response = await this.axiosInstance.get('/JSSResource/policies');
      const policies = response.data.policies || [];
      
      if (!query) {
        return policies.slice(0, limit);
      }
      
      const lowerQuery = query.toLowerCase();
      const filtered = policies.filter((p: any) => 
        p.name?.toLowerCase().includes(lowerQuery) ||
        p.id?.toString().includes(query)
      );
      
      return filtered.slice(0, limit);
    } catch (error) {
      logger.info('Failed to search policies:', error);
      return [];
    }
  }

  // Get policy details
  async getPolicyDetails(policyId: string): Promise<any> {
    await this.ensureAuthenticated();
    
    try {
      const response = await this.axiosInstance.get(`/JSSResource/policies/id/${policyId}`, {
        headers: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        params: {
          _ts: Date.now(),
        },
      });
      return response.data.policy;
    } catch (error) {
      logger.info('Failed to get policy details:', error);
      throw error;
    }
  }

  private async getPolicyDetailsFresh(policyId: string): Promise<any> {
    return await this.getPolicyDetails(policyId);
  }

  // Get raw Classic policy XML (useful for fields that Jamf omits in JSON, e.g. Self Service categories).
  async getPolicyXml(policyId: string): Promise<string> {
    await this.ensureAuthenticated();

    try {
      const response = await this.axiosInstance.get(`/JSSResource/policies/id/${policyId}`, {
        headers: {
          Accept: 'application/xml',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        params: {
          _ts: Date.now(),
        },
        // axios returns a string for non-JSON content-types in Node.
        responseType: 'text' as any,
        transformResponse: (d: any) => d,
      });
      return String((response as any).data ?? '');
    } catch (error) {
      logger.info('Failed to get policy XML:', error);
      throw error;
    }
  }

  /**
   * Create a new policy
   */
  async createPolicy(policyData: any): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create policies in read-only mode');
    }
    
    await this.ensureAuthenticated();

    // If the caller provides a Classic-shaped policy payload, use Classic XML directly.
    // The Modern /api/v1/policies payload shape differs (e.g. scope schema), and passing Classic-shaped
    // data produces misleading 400s like "Unrecognized field computer_groups".
    if (this.isClassicPolicyPayload(policyData)) {
      try {
        const xmlPayload = this.buildPolicyXml(policyData);
        const response = await this.axiosInstance.post(
          '/JSSResource/policies/id/0',
          xmlPayload,
          {
            headers: {
              'Content-Type': 'application/xml',
              'Accept': 'application/xml',
            },
          }
        );

        const locationHeader = response.headers.location;
        const policyId = locationHeader ? locationHeader.split('/').pop() : null;
        if (policyId) {
          return await this.getPolicyDetails(policyId);
        }
        return { success: true };
      } catch (classicError) {
        logger.info('Classic API policy create failed:', {
          status: getAxiosErrorStatus(classicError),
          data: getAxiosErrorData(classicError),
        });
        throw classicError;
      }
    }
    
    // Try Modern API first
    try {
      logger.info('Creating policy using Modern API...');
      logger.info('Policy data:', JSON.stringify(policyData, null, 2));
      const response = await this.axiosInstance.post('/api/v1/policies', policyData);
      return response.data;
    } catch (error) {
      logger.info(`Modern API failed with status ${getAxiosErrorStatus(error)}, trying Classic API...`);
      logger.info('Error details:', getAxiosErrorData(error));
      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
    }
    
    // Fall back to Classic API with XML format
    try {
      logger.info('Creating policy using Classic API with XML...');
      
      // Build XML payload
      const xmlPayload = this.buildPolicyXml(policyData);
      logger.info('XML Payload:', xmlPayload);
      
      const response = await this.axiosInstance.post(
        '/JSSResource/policies/id/0',
        xmlPayload,
        {
          headers: {
            'Content-Type': 'application/xml',
            'Accept': 'application/xml',
          }
        }
      );
      
      // Extract the created policy ID from the response
      const locationHeader = response.headers.location;
      const policyId = locationHeader ? locationHeader.split('/').pop() : null;
      
      if (policyId) {
        // Fetch and return the created policy details
        return await this.getPolicyDetails(policyId);
      }
      
      return { success: true };
    } catch (classicError) {
      logger.info('Classic API also failed:', classicError);
      throw classicError;
    }
  }

  /**
   * Update an existing policy
   */
  async updatePolicy(policyId: string, policyData: any): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update policies in read-only mode');
    }
    
    await this.ensureAuthenticated();

    return await this.withPolicyWriteLock(policyId, async () => {
      if (this.isClassicPolicyPayload(policyData)) {
        let updatedPolicy: any;
        try {
          // Lossless strategy: patch only requested fields on top of current Classic XML.
          // This avoids dropping unknown/tenant-specific nodes in touched sections.
          const existingXml = await this.getPolicyXml(policyId);
          const xmlPayload = this.patchPolicyXml(existingXml, policyData);
          updatedPolicy = await this.updatePolicyXml(policyId, xmlPayload, { skipPolicyWriteLock: true });
        } catch (xmlPatchError) {
          logger.warn('Classic XML patch update failed; falling back to merged Classic payload update', {
            status: getAxiosErrorStatus(xmlPatchError),
            data: getAxiosErrorData(xmlPatchError),
          });

          try {
            let existing: any | null = null;
            try {
              existing = await this.getPolicyDetails(policyId);
            } catch (e) {
              existing = null;
            }

            const deepMergeDefined = (base: any, patch: any): any => {
              if (patch === undefined) return base;
              if (patch === null) return null;
              if (Array.isArray(patch)) return patch;
              if (typeof patch === 'object' && patch) {
                const out: any =
                  base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
                for (const [k, v] of Object.entries(patch)) {
                  if (v === undefined) continue;
                  out[k] = deepMergeDefined(out[k], v);
                }
                return out;
              }
              return patch;
            };

            const merged: any = {};
            const existingName = existing?.general?.name ?? existing?.general?.policy_name ?? undefined;
            if (existingName) merged.general = { name: existingName };
            if (policyData.general !== undefined) {
              merged.general = deepMergeDefined(
                merged.general ?? {},
                deepMergeDefined(existing?.general ?? {}, policyData.general)
              );
            }
            if (policyData.self_service !== undefined) {
              merged.self_service = deepMergeDefined(existing?.self_service ?? {}, policyData.self_service);
            }
            if (policyData.maintenance !== undefined) {
              merged.maintenance = deepMergeDefined(existing?.maintenance ?? {}, policyData.maintenance);
            }
            if (policyData.scope !== undefined) {
              merged.scope = deepMergeDefined(existing?.scope ?? {}, policyData.scope);
            }
            if (policyData.package_configuration !== undefined) {
              merged.package_configuration = deepMergeDefined(
                existing?.package_configuration ?? {},
                policyData.package_configuration
              );
            }
            if (policyData.scripts !== undefined) {
              merged.scripts = deepMergeDefined(existing?.scripts ?? [], policyData.scripts);
            }

            const xmlPayload = this.buildPolicyXml(merged);
            updatedPolicy = await this.updatePolicyXml(policyId, xmlPayload, { skipPolicyWriteLock: true });
          } catch (classicError) {
            logger.info('Classic API policy update failed:', {
              status: getAxiosErrorStatus(classicError),
              data: getAxiosErrorData(classicError),
            });
            throw classicError;
          }
        }

        return await this.verifyPolicyUpdatePersisted(policyId, policyData, updatedPolicy);
      }
      
      // Try Modern API first
      try {
        logger.info(`Updating policy ${policyId} using Modern API...`);
        const response = await this.axiosInstance.put(`/api/v1/policies/${policyId}`, policyData);
        return response.data;
      } catch (error) {
        logger.info(`Modern API failed with status ${getAxiosErrorStatus(error)}, trying Classic API...`);
        logger.info('Error details:', getAxiosErrorData(error));
        if (!this.shouldFallbackToClassicOnModernError(error)) {
          throw error;
        }
      }
      
      // Fall back to Classic API with XML format
      try {
        logger.info(`Updating policy ${policyId} using Classic API with XML...`);
        
        // Build XML payload
        const xmlPayload = this.buildPolicyXml(policyData);
        return await this.updatePolicyXml(policyId, xmlPayload, { skipPolicyWriteLock: true });
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    });
  }

  private escapeXmlValue(str: string): string {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private getXmlArrayItemTag(parentTag: string): string {
    const directMap: Record<string, string> = {
      computers: 'computer',
      computer_groups: 'computer_group',
      buildings: 'building',
      departments: 'department',
      jss_users: 'jss_user',
      jss_user_groups: 'jss_user_group',
      packages: 'package',
      scripts: 'script',
      categories: 'category',
    };

    if (directMap[parentTag]) return directMap[parentTag];
    if (parentTag.endsWith('ies')) return `${parentTag.slice(0, -3)}y`;
    if (parentTag.endsWith('s')) return parentTag.slice(0, -1);
    return 'item';
  }

  private serializeXmlNodeValue(value: any, parentTag?: string): string {
    if (value === undefined || value === null) return '';

    if (Array.isArray(value)) {
      const itemTag = this.getXmlArrayItemTag(parentTag ?? 'item');
      return value
        .map((item) => `<${itemTag}>${this.serializeXmlNodeValue(item, itemTag)}</${itemTag}>`)
        .join('');
    }

    if (typeof value === 'object') {
      return Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `<${k}>${this.serializeXmlNodeValue(v, k)}</${k}>`)
        .join('');
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    return this.escapeXmlValue(String(value));
  }

  private withPolicySection(
    xml: string,
    sectionTag: string,
    updater: (sectionXml: string) => string
  ): string {
    const sectionRegex = new RegExp(`<${sectionTag}>[\\s\\S]*?<\\/${sectionTag}>`, 'i');
    const existingMatch = xml.match(sectionRegex);

    if (existingMatch) {
      const updatedSection = updater(existingMatch[0]);
      return xml.replace(sectionRegex, updatedSection);
    }

    const createdSection = updater(`<${sectionTag}></${sectionTag}>`);
    if (/<\/policy>/i.test(xml)) {
      return xml.replace(/<\/policy>/i, `${createdSection}</policy>`);
    }

    return `${xml}\n${createdSection}\n`;
  }

  private upsertSectionChild(
    sectionXml: string,
    sectionTag: string,
    childTag: string,
    childInnerXml: string
  ): string {
    const childRegex = new RegExp(`<${childTag}>[\\s\\S]*?<\\/${childTag}>`, 'i');
    const childXml = `<${childTag}>${childInnerXml}</${childTag}>`;

    if (childRegex.test(sectionXml)) {
      return sectionXml.replace(childRegex, childXml);
    }

    return sectionXml.replace(new RegExp(`</${sectionTag}>`, 'i'), `${childXml}</${sectionTag}>`);
  }

  private toSelfServiceCategoryList(input: any): Array<{ id?: unknown; name?: unknown; display_in?: unknown; feature_in?: unknown }> {
    if (input === undefined || input === null) return [];
    if (typeof input === 'string') {
      const name = input.trim();
      return name ? [{ name }] : [];
    }
    if (Array.isArray(input)) {
      return input
        .flatMap((x) => this.toSelfServiceCategoryList(x))
        .filter((c) => c && (c.id !== undefined || (typeof c.name === 'string' && c.name.trim())));
    }
    if (typeof input === 'object') {
      if ('category' in (input as any)) {
        return this.toSelfServiceCategoryList((input as any).category);
      }
      return [
        {
          id: (input as any).id,
          name: (input as any).name,
          display_in: (input as any).display_in ?? (input as any).displayIn,
          feature_in: (input as any).feature_in ?? (input as any).featureIn,
        },
      ];
    }
    return [];
  }

  private renderSelfServiceCategoriesXml(categories: Array<{ id?: unknown; name?: unknown; display_in?: unknown; feature_in?: unknown }>): string {
    let xml = `<size>${categories.length}</size>`;
    for (const c of categories) {
      const id = (c as any).id;
      const name = (c as any).name;
      const displayIn = (c as any).display_in ?? true;
      const featureIn = (c as any).feature_in ?? false;
      xml += '<category>';
      if (id !== undefined && id !== null) {
        xml += `<id>${this.escapeXmlValue(String(id))}</id>`;
      }
      if (name !== undefined && name !== null && String(name).trim() !== '') {
        xml += `<name>${this.escapeXmlValue(String(name))}</name>`;
      }
      xml += `<display_in>${Boolean(displayIn)}</display_in>`;
      xml += `<feature_in>${Boolean(featureIn)}</feature_in>`;
      xml += '</category>';
    }
    return xml;
  }

  private patchGeneralPolicyXml(xml: string, general: any): string {
    return this.withPolicySection(xml, 'general', (sectionXml) => {
      let next = sectionXml;
      for (const [key, rawValue] of Object.entries(general ?? {})) {
        if (rawValue === undefined) continue;

        if (key === 'category') {
          if (typeof rawValue === 'string') {
            next = this.upsertSectionChild(next, 'general', 'category', `<name>${this.escapeXmlValue(rawValue)}</name>`);
          } else if (rawValue && typeof rawValue === 'object') {
            const id = (rawValue as any).id;
            const name = (rawValue as any).name;
            let inner = '';
            if (id !== undefined && id !== null) inner += `<id>${this.escapeXmlValue(String(id))}</id>`;
            if (name !== undefined && name !== null && String(name).trim() !== '') {
              inner += `<name>${this.escapeXmlValue(String(name))}</name>`;
            }
            next = this.upsertSectionChild(next, 'general', 'category', inner);
          } else {
            next = this.upsertSectionChild(next, 'general', 'category', '');
          }
          continue;
        }

        if (key === 'frequency' && rawValue !== null && rawValue !== '') {
          const normalizedFrequency = normalizePolicyFrequency(String(rawValue)) ?? String(rawValue);
          next = this.upsertSectionChild(next, 'general', key, this.escapeXmlValue(normalizedFrequency));
          continue;
        }

        if (key === 'network_requirements' && rawValue !== null && rawValue !== '') {
          const normalized = normalizePolicyNetworkRequirements(String(rawValue)) ?? String(rawValue);
          next = this.upsertSectionChild(next, 'general', key, this.escapeXmlValue(normalized));
          continue;
        }

        if (key === 'network_limitations' && rawValue && typeof rawValue === 'object') {
          const networkLimitations = rawValue as any;
          const normalizedConnection = normalizePolicyMinimumNetworkConnection(
            networkLimitations.minimum_network_connection
          ) ?? networkLimitations.minimum_network_connection;
          const normalizedValue = {
            ...networkLimitations,
            minimum_network_connection: normalizedConnection,
          };
          next = this.upsertSectionChild(
            next,
            'general',
            key,
            this.serializeXmlNodeValue(normalizedValue, key)
          );
          continue;
        }

        next = this.upsertSectionChild(next, 'general', key, this.serializeXmlNodeValue(rawValue, key));
      }
      return next;
    });
  }

  private patchScopePolicyXml(xml: string, scope: any): string {
    return this.withPolicySection(xml, 'scope', (sectionXml) => {
      let next = sectionXml;
      for (const [key, value] of Object.entries(scope ?? {})) {
        if (value === undefined) continue;
        next = this.upsertSectionChild(next, 'scope', key, this.serializeXmlNodeValue(value, key));
      }
      return next;
    });
  }

  private patchSelfServicePolicyXml(xml: string, selfService: any): string {
    return this.withPolicySection(xml, 'self_service', (sectionXml) => {
      let next = sectionXml;
      for (const [key, value] of Object.entries(selfService ?? {})) {
        if (value === undefined) continue;
        if (key === 'self_service_category' || key === 'self_service_categories') continue;
        next = this.upsertSectionChild(next, 'self_service', key, this.serializeXmlNodeValue(value, key));
      }

      const touchedCategories =
        Object.prototype.hasOwnProperty.call(selfService ?? {}, 'self_service_category') ||
        Object.prototype.hasOwnProperty.call(selfService ?? {}, 'self_service_categories');

      if (touchedCategories) {
        const categories =
          (selfService.self_service_categories !== undefined &&
          this.toSelfServiceCategoryList(selfService.self_service_categories).length > 0)
            ? this.toSelfServiceCategoryList(selfService.self_service_categories)
            : this.toSelfServiceCategoryList(selfService.self_service_category);

        const firstName = String((categories[0] as any)?.name ?? '').trim();
        next = this.upsertSectionChild(
          next,
          'self_service',
          'self_service_category',
          this.escapeXmlValue(firstName)
        );
        next = this.upsertSectionChild(
          next,
          'self_service',
          'self_service_categories',
          this.renderSelfServiceCategoriesXml(categories)
        );
      }

      return next;
    });
  }

  private patchPackageConfigurationPolicyXml(xml: string, packageConfiguration: any): string {
    return this.withPolicySection(xml, 'package_configuration', (sectionXml) => {
      let next = sectionXml;
      for (const [key, value] of Object.entries(packageConfiguration ?? {})) {
        if (value === undefined) continue;
        next = this.upsertSectionChild(next, 'package_configuration', key, this.serializeXmlNodeValue(value, key));
      }
      return next;
    });
  }

  private patchMaintenancePolicyXml(xml: string, maintenance: any): string {
    return this.withPolicySection(xml, 'maintenance', (sectionXml) => {
      let next = sectionXml;
      for (const [key, value] of Object.entries(maintenance ?? {})) {
        if (value === undefined) continue;
        next = this.upsertSectionChild(next, 'maintenance', key, this.serializeXmlNodeValue(value, key));
      }
      return next;
    });
  }

  private patchScriptsPolicyXml(xml: string, scripts: any): string {
    const normalizedScripts = (Array.isArray(scripts) ? scripts : []).map((script) => {
      if (!script || typeof script !== 'object') return script;
      const priority = (script as any).priority;
      if (priority === undefined) return script;
      return {
        ...(script as any),
        priority: normalizeScriptPriority(String(priority)) ?? String(priority),
      };
    });

    return this.withPolicySection(
      xml,
      'scripts',
      () => `<scripts>${this.serializeXmlNodeValue(normalizedScripts, 'scripts')}</scripts>`
    );
  }

  private patchPolicyXml(existingXml: string, patch: any): string {
    let xml = String(existingXml ?? '');
    if (!xml.trim()) {
      throw new Error('Cannot patch policy XML because existing XML is empty');
    }

    if (patch?.general !== undefined) {
      xml = this.patchGeneralPolicyXml(xml, patch.general);
    }
    if (patch?.scope !== undefined) {
      xml = this.patchScopePolicyXml(xml, patch.scope);
    }
    if (patch?.self_service !== undefined) {
      xml = this.patchSelfServicePolicyXml(xml, patch.self_service);
    }
    if (patch?.maintenance !== undefined) {
      xml = this.patchMaintenancePolicyXml(xml, patch.maintenance);
    }
    if (patch?.package_configuration !== undefined) {
      xml = this.patchPackageConfigurationPolicyXml(xml, patch.package_configuration);
    }
    if (patch?.scripts !== undefined) {
      xml = this.patchScriptsPolicyXml(xml, patch.scripts);
    }

    return xml;
  }

  private collectVerifiablePolicyExpectations(
    value: any,
    pathPrefix: string,
    out: Array<{ path: string; expected: any }>
  ): void {
    if (value === undefined) return;
    if (value === null || typeof value !== 'object') {
      out.push({ path: pathPrefix, expected: value });
      return;
    }
    if (Array.isArray(value)) {
      return;
    }

    for (const [key, raw] of Object.entries(value)) {
      if (raw === undefined) continue;
      const path = pathPrefix ? `${pathPrefix}.${key}` : key;

      if (path === 'self_service.self_service_category' || path === 'self_service.self_service_categories') {
        continue;
      }

      if (path === 'general.category' && typeof raw === 'string') {
        out.push({ path: 'general.category.name', expected: raw });
        continue;
      }
      if (path === 'general.frequency' && typeof raw === 'string') {
        const normalizedFrequency = normalizePolicyFrequency(raw) ?? raw;
        out.push({ path, expected: normalizedFrequency });
        continue;
      }
      if (path === 'general.network_requirements' && typeof raw === 'string') {
        const normalizedReq = normalizePolicyNetworkRequirements(raw) ?? raw;
        out.push({ path, expected: normalizedReq });
        continue;
      }
      if (path === 'general.network_limitations.minimum_network_connection' && typeof raw === 'string') {
        const normalizedConn = normalizePolicyMinimumNetworkConnection(raw) ?? raw;
        out.push({ path, expected: normalizedConn });
        continue;
      }

      this.collectVerifiablePolicyExpectations(raw, path, out);
    }
  }

  private getValueAtPath(obj: any, path: string): any {
    return String(path)
      .split('.')
      .reduce((acc: any, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
  }

  private policyValuesEqual(actual: any, expected: any): boolean {
    if (expected === null) return actual === null;

    if (typeof expected === 'boolean') {
      if (typeof actual === 'boolean') return actual === expected;
      const lower = String(actual ?? '').toLowerCase();
      return lower === String(expected);
    }

    if (typeof expected === 'number') {
      const n = typeof actual === 'number' ? actual : Number(actual);
      return Number.isFinite(n) && n === expected;
    }

    if (typeof expected === 'string') {
      return String(actual ?? '') === expected;
    }

    return JSON.stringify(actual) === JSON.stringify(expected);
  }

  private findPolicyExpectationMismatches(
    policy: any,
    expectations: Array<{ path: string; expected: any }>
  ): string[] {
    const mismatches: string[] = [];
    for (const exp of expectations) {
      const actual = this.getValueAtPath(policy, exp.path);
      if (!this.policyValuesEqual(actual, exp.expected)) {
        mismatches.push(
          `${exp.path} (expected=${JSON.stringify(exp.expected)}, actual=${JSON.stringify(actual)})`
        );
      }
    }
    return mismatches;
  }

  private collectVerifiableScalarExpectations(
    value: any,
    pathPrefix: string,
    out: Array<{ path: string; expected: any }>
  ): void {
    if (value === undefined) return;
    if (value === null || typeof value !== 'object') {
      if (pathPrefix) out.push({ path: pathPrefix, expected: value });
      return;
    }
    if (Array.isArray(value)) return;

    for (const [key, raw] of Object.entries(value)) {
      if (raw === undefined) continue;
      const path = pathPrefix ? `${pathPrefix}.${key}` : key;
      this.collectVerifiableScalarExpectations(raw, path, out);
    }
  }

  private collectScriptVerifyExpectations(scriptData: JamfScriptUpdateInput): Array<{ path: string; expected: any }> {
    const expectations: Array<{ path: string; expected: any }> = [];
    const patch = scriptData ?? {};

    if (patch.name !== undefined) expectations.push({ path: 'name', expected: String(patch.name) });
    if (patch.category !== undefined) expectations.push({ path: 'category', expected: String(patch.category) });
    if (patch.info !== undefined) expectations.push({ path: 'info', expected: String(patch.info) });
    if (patch.notes !== undefined) expectations.push({ path: 'notes', expected: String(patch.notes) });
    if (patch.priority !== undefined) {
      const normalizedPriority = normalizeScriptPriority(String(patch.priority)) ?? String(patch.priority);
      expectations.push({ path: 'priority', expected: normalizedPriority });
    }
    if (patch.script_contents !== undefined) {
      expectations.push({ path: 'scriptContents', expected: String(patch.script_contents) });
    }
    if (patch.script_contents_encoded !== undefined) {
      expectations.push({ path: 'scriptContentsEncoded', expected: Boolean(patch.script_contents_encoded) });
    }
    if (patch.os_requirements !== undefined) {
      expectations.push({ path: 'osRequirements', expected: String(patch.os_requirements) });
    }

    if (patch.parameters && typeof patch.parameters === 'object') {
      for (const [key, raw] of Object.entries(patch.parameters)) {
        if (raw === undefined) continue;
        expectations.push({ path: `parameters.${key}`, expected: String(raw) });
      }
    }

    return expectations;
  }

  private async verifyScriptUpdatePersisted(
    scriptId: string,
    patch: JamfScriptUpdateInput,
    initialScript?: JamfScriptDetails
  ): Promise<JamfScriptDetails> {
    const strictEnabled = String(process.env.JAMF_SCRIPT_VERIFY_ENABLED ?? 'true').toLowerCase() !== 'false';
    if (!strictEnabled) {
      return initialScript ?? (await this.getScriptDetails(scriptId));
    }

    const expectations = this.collectScriptVerifyExpectations(patch);
    if (expectations.length === 0) {
      return initialScript ?? (await this.getScriptDetails(scriptId));
    }

    const attempts = Math.max(1, Number(process.env.JAMF_SCRIPT_VERIFY_ATTEMPTS ?? 8));
    const delayMs = Math.max(0, Number(process.env.JAMF_SCRIPT_VERIFY_DELAY_MS ?? 250));
    const requiredConsistentReads = Math.max(
      1,
      Number(process.env.JAMF_SCRIPT_VERIFY_REQUIRED_CONSISTENT_READS ?? 2)
    );

    let candidate: JamfScriptDetails | undefined;
    let lastMismatches: string[] = [];
    let matchedReads = 0;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      candidate = await this.getScriptDetails(scriptId);
      const mismatches = this.findPolicyExpectationMismatches(candidate, expectations);

      if (mismatches.length === 0) {
        matchedReads += 1;
        if (matchedReads >= requiredConsistentReads) {
          return candidate;
        }
      } else {
        matchedReads = 0;
        lastMismatches = mismatches;
      }

      if (attempt < attempts) {
        await this.sleep(delayMs * attempt);
      }
    }

    const sample = lastMismatches.slice(0, 6).join('; ');
    throw new Error(
      `Script ${scriptId} update did not persist requested fields after ${attempts} checks (required consistent reads: ${requiredConsistentReads}): ${sample}`
    );
  }

  private extractPatchSoftwareTitleConfigurationId(payload: any): string | null {
    const readId = (obj: any): string | null => {
      if (!obj || typeof obj !== 'object') return null;
      const candidateKeys = ['id', 'configId', 'configurationId', 'patchSoftwareTitleConfigurationId'];
      for (const key of candidateKeys) {
        const raw = (obj as any)[key];
        if (typeof raw === 'string' && raw.trim()) return raw;
        if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
      }
      return null;
    };

    return (
      readId(payload) ??
      readId((payload as any)?.result) ??
      readId((payload as any)?.configuration) ??
      readId((payload as any)?.patchSoftwareTitleConfiguration) ??
      null
    );
  }

  private collectPatchVerifyExpectations(
    patch: any,
    options?: { topLevelOnly?: boolean }
  ): Array<{ path: string; expected: any }> {
    const expectations: Array<{ path: string; expected: any }> = [];
    if (!patch || typeof patch !== 'object') return expectations;

    if (options?.topLevelOnly) {
      for (const [key, raw] of Object.entries(patch)) {
        if (raw === undefined) continue;
        if (raw === null || (typeof raw !== 'object' && !Array.isArray(raw))) {
          expectations.push({ path: key, expected: raw });
        }
      }
      return expectations;
    }

    this.collectVerifiableScalarExpectations(patch, '', expectations);
    return expectations;
  }

  private async verifyPatchSoftwareTitleConfigurationPersisted(
    configId: string,
    patch: any,
    initialConfig?: any,
    options?: { topLevelOnly?: boolean }
  ): Promise<any> {
    const strictEnabled = String(process.env.JAMF_PATCH_VERIFY_ENABLED ?? 'true').toLowerCase() !== 'false';
    if (!strictEnabled) {
      return initialConfig ?? (await this.getPatchSoftwareTitleConfiguration(configId));
    }

    const expectations = this.collectPatchVerifyExpectations(patch, options);
    if (expectations.length === 0) {
      return initialConfig ?? (await this.getPatchSoftwareTitleConfiguration(configId));
    }

    const attempts = Math.max(1, Number(process.env.JAMF_PATCH_VERIFY_ATTEMPTS ?? 8));
    const delayMs = Math.max(0, Number(process.env.JAMF_PATCH_VERIFY_DELAY_MS ?? 250));
    const requiredConsistentReads = Math.max(
      1,
      Number(process.env.JAMF_PATCH_VERIFY_REQUIRED_CONSISTENT_READS ?? 2)
    );

    let candidate: any;
    let lastMismatches: string[] = [];
    let matchedReads = 0;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      candidate = await this.getPatchSoftwareTitleConfiguration(configId);
      const mismatches = this.findPolicyExpectationMismatches(candidate, expectations);

      if (mismatches.length === 0) {
        matchedReads += 1;
        if (matchedReads >= requiredConsistentReads) {
          return candidate;
        }
      } else {
        matchedReads = 0;
        lastMismatches = mismatches;
      }

      if (attempt < attempts) {
        await this.sleep(delayMs * attempt);
      }
    }

    const sample = lastMismatches.slice(0, 6).join('; ');
    throw new Error(
      `Patch software title configuration ${configId} update did not persist requested fields after ${attempts} checks (required consistent reads: ${requiredConsistentReads}): ${sample}`
    );
  }

  private async verifyPatchSoftwareTitleConfigurationDeleted(configId: string): Promise<void> {
    const strictEnabled = String(process.env.JAMF_PATCH_VERIFY_ENABLED ?? 'true').toLowerCase() !== 'false';
    if (!strictEnabled) return;

    const attempts = Math.max(1, Number(process.env.JAMF_PATCH_VERIFY_ATTEMPTS ?? 8));
    const delayMs = Math.max(0, Number(process.env.JAMF_PATCH_VERIFY_DELAY_MS ?? 250));

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.getPatchSoftwareTitleConfiguration(configId);
      } catch (error) {
        if (getAxiosErrorStatus(error) === 404) {
          return;
        }
        throw error;
      }

      if (attempt < attempts) {
        await this.sleep(delayMs * attempt);
      }
    }

    throw new Error(
      `Patch software title configuration ${configId} was not deleted after ${attempts} checks`
    );
  }

  private isPolicyXmlVerifiableExpectation(path: string, expected: any): boolean {
    if (expected === undefined || expected === null) return false;
    if (typeof expected === 'object') return false;

    // Only verify scalar fields that map 1:1 to Classic policy XML nodes.
    return path === 'general.name' || path.startsWith('self_service.') || path.startsWith('maintenance.');
  }

  private getXmlValueAtPath(xml: string, path: string): any {
    let current = String(xml ?? '');
    if (!current || !path) return undefined;

    for (const segment of String(path).split('.')) {
      const tag = segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = current.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
      if (!match) return undefined;
      current = String(match[1] ?? '');
    }

    if (/<[a-zA-Z][\w:-]*[\s>]/.test(current)) {
      return undefined;
    }
    return this.decodeXmlEntities(current.trim());
  }

  private findPolicyExpectationMismatchesInXml(
    xml: string,
    expectations: Array<{ path: string; expected: any }>
  ): string[] {
    const mismatches: string[] = [];
    for (const exp of expectations) {
      const actual = this.getXmlValueAtPath(xml, exp.path);
      if (!this.policyValuesEqual(actual, exp.expected)) {
        mismatches.push(
          `${exp.path} (expected=${JSON.stringify(exp.expected)}, actual=${JSON.stringify(actual)})`
        );
      }
    }
    return mismatches;
  }

  private async verifyPolicyUpdatePersisted(policyId: string, patch: any, initialPolicy?: any): Promise<any> {
    const expectations: Array<{ path: string; expected: any }> = [];
    this.collectVerifiablePolicyExpectations(patch, '', expectations);

    if (expectations.length === 0) {
      return initialPolicy ?? (await this.getPolicyDetails(policyId));
    }

    const attempts = Math.max(1, Number(process.env.JAMF_POLICY_VERIFY_ATTEMPTS ?? 12));
    const delayMs = Math.max(0, Number(process.env.JAMF_POLICY_VERIFY_DELAY_MS ?? 300));
    const requireXmlVerification = String(process.env.JAMF_POLICY_VERIFY_REQUIRE_XML ?? 'true').toLowerCase() !== 'false';
    const xmlExpectations = requireXmlVerification
      ? expectations.filter((exp) => this.isPolicyXmlVerifiableExpectation(exp.path, exp.expected))
      : [];
    const requiredConsistentReads = Math.max(
      1,
      Number(process.env.JAMF_POLICY_VERIFY_REQUIRED_CONSISTENT_READS ?? 2)
    );

    let candidate: any;
    let lastMismatches: string[] = [];
    let matchedReads = 0;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Always use a fresh read for verification.
      // Never trust the immediate write response as persisted ground truth.
      candidate = await this.getPolicyDetailsFresh(policyId);

      const jsonMismatches = this.findPolicyExpectationMismatches(candidate, expectations);

      let xmlMismatches: string[] = [];
      if (xmlExpectations.length > 0) {
        const policyXml = await this.getPolicyXml(policyId);
        xmlMismatches = this.findPolicyExpectationMismatchesInXml(policyXml, xmlExpectations);
      }

      if (jsonMismatches.length === 0 && xmlMismatches.length === 0) {
        matchedReads += 1;
        if (matchedReads >= requiredConsistentReads) {
          return candidate;
        }
      } else {
        matchedReads = 0;
        lastMismatches = [
          ...jsonMismatches.map((m) => `json:${m}`),
          ...xmlMismatches.map((m) => `xml:${m}`),
        ];
      }

      if (attempt < attempts) {
        await this.sleep(delayMs * attempt);
      }
    }

    const sample = lastMismatches.slice(0, 6).join('; ');
    throw new Error(
      `Policy ${policyId} update did not persist requested fields after ${attempts} fresh checks (required consistent reads: ${requiredConsistentReads}): ${sample}`
    );
  }

  /**
   * Clone an existing policy
   */
  async clonePolicy(sourcePolicyId: string, newName: string): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot clone policies in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    try {
      // Get the source policy details
      logger.info(`Getting source policy ${sourcePolicyId} details for cloning...`);
      const sourcePolicy = await this.getPolicyDetails(sourcePolicyId);
      
      // Create a copy of the policy with a new name
      const clonedPolicy = { ...sourcePolicy };
      delete clonedPolicy.id;
      clonedPolicy.general = { ...clonedPolicy.general };
      clonedPolicy.general.name = newName;
      
      // Remove any unique identifiers that shouldn't be copied
      delete clonedPolicy.general.id;
      
      // Create the new policy
      return await this.createPolicy(clonedPolicy);
    } catch (error) {
      logger.info('Failed to clone policy:', error);
      throw error;
    }
  }

  /**
   * Enable or disable a policy
   */
  async setPolicyEnabled(policyId: string, enabled: boolean): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot enable/disable policies in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    try {
      // Get current policy details
      const policy = await this.getPolicyDetails(policyId);
      
      // Update only the enabled status
      const updateData = {
        general: {
          enabled: enabled
        }
      };
      
      return await this.updatePolicy(policyId, updateData);
    } catch (error) {
      logger.info(`Failed to ${enabled ? 'enable' : 'disable'} policy:`, error);
      throw error;
    }
  }

  /**
   * Update policy scope (add/remove computers and groups)
   */
  async updatePolicyScope(policyId: string, scopeUpdates: {
    addComputers?: string[];
    removeComputers?: string[];
    addComputerGroups?: string[];
    removeComputerGroups?: string[];
    replaceComputers?: string[];
    replaceComputerGroups?: string[];
  }): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update policy scope in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    try {
      // Get current policy details
      const policy = await this.getPolicyDetails(policyId);
      const currentScope = policy.scope || {};
      
      // Initialize scope arrays if they don't exist
      let computers = currentScope.computers || [];
      let computerGroups = currentScope.computer_groups || [];
      
      // Handle replacements
      if (scopeUpdates.replaceComputers !== undefined) {
        computers = scopeUpdates.replaceComputers.map(id => ({ id: parseInt(id) }));
      } else {
        // Handle additions and removals for computers
        if (scopeUpdates.addComputers) {
          const newComputers = scopeUpdates.addComputers.map(id => ({ id: parseInt(id) }));
          computers = [...computers, ...newComputers];
        }
        
        if (scopeUpdates.removeComputers) {
          const removeIds = scopeUpdates.removeComputers.map(id => parseInt(id));
          computers = computers.filter((c: any) => !removeIds.includes(c.id));
        }
      }
      
      if (scopeUpdates.replaceComputerGroups !== undefined) {
        computerGroups = scopeUpdates.replaceComputerGroups.map(id => ({ id: parseInt(id) }));
      } else {
        // Handle additions and removals for computer groups
        if (scopeUpdates.addComputerGroups) {
          const newGroups = scopeUpdates.addComputerGroups.map(id => ({ id: parseInt(id) }));
          computerGroups = [...computerGroups, ...newGroups];
        }
        
        if (scopeUpdates.removeComputerGroups) {
          const removeIds = scopeUpdates.removeComputerGroups.map(id => parseInt(id));
          computerGroups = computerGroups.filter((g: any) => !removeIds.includes(g.id));
        }
      }
      
      // Update the policy with the new scope
      const updateData = {
        scope: {
          ...currentScope,
          computers: computers,
          computer_groups: computerGroups
        }
      };
      
      return await this.updatePolicy(policyId, updateData);
    } catch (error) {
      logger.info('Failed to update policy scope:', error);
      throw error;
    }
  }

  /**
   * Build XML payload for policy creation/update
   */
  private buildPolicyXml(policyData: any): string {
    const escapeXml = (str: string): string => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };
    
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<policy>\n';
    
    // General settings
    if (policyData.general) {
      xml += '  <general>\n';
      if (policyData.general.name) xml += `    <name>${escapeXml(policyData.general.name)}</name>\n`;
      if (policyData.general.enabled !== undefined) xml += `    <enabled>${policyData.general.enabled}</enabled>\n`;
      if (policyData.general.trigger) xml += `    <trigger>${escapeXml(policyData.general.trigger)}</trigger>\n`;
      if (policyData.general.trigger_checkin !== undefined) xml += `    <trigger_checkin>${policyData.general.trigger_checkin}</trigger_checkin>\n`;
      if (policyData.general.trigger_enrollment_complete !== undefined) xml += `    <trigger_enrollment_complete>${policyData.general.trigger_enrollment_complete}</trigger_enrollment_complete>\n`;
      if (policyData.general.trigger_login !== undefined) xml += `    <trigger_login>${policyData.general.trigger_login}</trigger_login>\n`;
      if (policyData.general.trigger_logout !== undefined) xml += `    <trigger_logout>${policyData.general.trigger_logout}</trigger_logout>\n`;
      if (policyData.general.trigger_network_state_changed !== undefined) xml += `    <trigger_network_state_changed>${policyData.general.trigger_network_state_changed}</trigger_network_state_changed>\n`;
      if (policyData.general.trigger_startup !== undefined) xml += `    <trigger_startup>${policyData.general.trigger_startup}</trigger_startup>\n`;
      if (policyData.general.trigger_other) xml += `    <trigger_other>${escapeXml(policyData.general.trigger_other)}</trigger_other>\n`;
      if (policyData.general.frequency) {
        const normalizedFrequency = normalizePolicyFrequency(policyData.general.frequency) ?? String(policyData.general.frequency);
        xml += `    <frequency>${escapeXml(normalizedFrequency)}</frequency>\n`;
      }
      if (policyData.general.retry_event) xml += `    <retry_event>${escapeXml(policyData.general.retry_event)}</retry_event>\n`;
      if (policyData.general.retry_attempts !== undefined) xml += `    <retry_attempts>${policyData.general.retry_attempts}</retry_attempts>\n`;
      if (policyData.general.notify_on_each_failed_retry !== undefined) xml += `    <notify_on_each_failed_retry>${policyData.general.notify_on_each_failed_retry}</notify_on_each_failed_retry>\n`;
      if (policyData.general.location_user_only !== undefined) xml += `    <location_user_only>${policyData.general.location_user_only}</location_user_only>\n`;
      if (policyData.general.target_drive) xml += `    <target_drive>${escapeXml(policyData.general.target_drive)}</target_drive>\n`;
      if (policyData.general.offline !== undefined) xml += `    <offline>${policyData.general.offline}</offline>\n`;
      if (policyData.general.category) {
        const category = policyData.general.category;
        if (typeof category === 'string') {
          xml += `    <category><name>${escapeXml(category)}</name></category>\n`;
        } else if (category && typeof category === 'object') {
          const id = (category as any).id;
          const name = (category as any).name;
          xml += '    <category>';
          if (id !== undefined && id !== null) xml += `<id>${escapeXml(String(id))}</id>`;
          if (name) xml += `<name>${escapeXml(String(name))}</name>`;
          xml += '</category>\n';
        }
      }

      // Optional Classic enums: normalize if present (not all callers include these).
      if ((policyData.general as any).network_requirements !== undefined) {
        const nr = normalizePolicyNetworkRequirements((policyData.general as any).network_requirements);
        if (nr) xml += `    <network_requirements>${escapeXml(nr)}</network_requirements>\n`;
      }
      if ((policyData.general as any).network_limitations) {
        const nl = (policyData.general as any).network_limitations;
        const minConn = normalizePolicyMinimumNetworkConnection(nl.minimum_network_connection);
        const anyIp = nl.any_ip_address;
        if (minConn || anyIp !== undefined) {
          xml += '    <network_limitations>\n';
          if (minConn) xml += `      <minimum_network_connection>${escapeXml(minConn)}</minimum_network_connection>\n`;
          if (anyIp !== undefined) xml += `      <any_ip_address>${Boolean(anyIp)}</any_ip_address>\n`;
          xml += '    </network_limitations>\n';
        }
      }
      xml += '  </general>\n';
    }
    
    // Scope
    if (policyData.scope) {
      xml += '  <scope>\n';
      if (policyData.scope.all_computers !== undefined) {
        xml += `    <all_computers>${policyData.scope.all_computers}</all_computers>\n`;
      }
      if (policyData.scope.computers && policyData.scope.computers.length > 0) {
        xml += '    <computers>\n';
        policyData.scope.computers.forEach((computer: any) => {
          xml += `      <computer><id>${computer.id}</id></computer>\n`;
        });
        xml += '    </computers>\n';
      }
      if (policyData.scope.computer_groups && policyData.scope.computer_groups.length > 0) {
        xml += '    <computer_groups>\n';
        policyData.scope.computer_groups.forEach((group: any) => {
          xml += `      <computer_group><id>${group.id}</id></computer_group>\n`;
        });
        xml += '    </computer_groups>\n';
      }
      if (policyData.scope.buildings && policyData.scope.buildings.length > 0) {
        xml += '    <buildings>\n';
        policyData.scope.buildings.forEach((building: any) => {
          xml += `      <building><id>${building.id}</id></building>\n`;
        });
        xml += '    </buildings>\n';
      }
      if (policyData.scope.departments && policyData.scope.departments.length > 0) {
        xml += '    <departments>\n';
        policyData.scope.departments.forEach((dept: any) => {
          xml += `      <department><id>${dept.id}</id></department>\n`;
        });
        xml += '    </departments>\n';
      }
      xml += '  </scope>\n';
    }
    
    // Self Service
    if (policyData.self_service) {
      xml += '  <self_service>\n';
      if (policyData.self_service.use_for_self_service !== undefined) xml += `    <use_for_self_service>${policyData.self_service.use_for_self_service}</use_for_self_service>\n`;
      if (policyData.self_service.self_service_display_name !== undefined) xml += `    <self_service_display_name>${escapeXml(String(policyData.self_service.self_service_display_name ?? ''))}</self_service_display_name>\n`;
      if (policyData.self_service.install_button_text !== undefined) xml += `    <install_button_text>${escapeXml(String(policyData.self_service.install_button_text ?? ''))}</install_button_text>\n`;
      if (policyData.self_service.reinstall_button_text !== undefined) xml += `    <reinstall_button_text>${escapeXml(String(policyData.self_service.reinstall_button_text ?? ''))}</reinstall_button_text>\n`;
      if (policyData.self_service.self_service_description !== undefined) xml += `    <self_service_description>${escapeXml(String(policyData.self_service.self_service_description ?? ''))}</self_service_description>\n`;
      if (policyData.self_service.force_users_to_view_description !== undefined) xml += `    <force_users_to_view_description>${policyData.self_service.force_users_to_view_description}</force_users_to_view_description>\n`;
      if (policyData.self_service.feature_on_main_page !== undefined) xml += `    <feature_on_main_page>${policyData.self_service.feature_on_main_page}</feature_on_main_page>\n`;
      if (policyData.self_service.notification !== undefined) xml += `    <notification>${policyData.self_service.notification}</notification>\n`;
      if (policyData.self_service.notification_type !== undefined) xml += `    <notification_type>${escapeXml(String(policyData.self_service.notification_type ?? ''))}</notification_type>\n`;
      if (policyData.self_service.notification_subject !== undefined) xml += `    <notification_subject>${escapeXml(String(policyData.self_service.notification_subject ?? ''))}</notification_subject>\n`;
      if (policyData.self_service.notification_message !== undefined) xml += `    <notification_message>${escapeXml(String(policyData.self_service.notification_message ?? ''))}</notification_message>\n`;

      // Self Service category (policy). Policies effectively support one category.
      // Jamf Classic policy XML uses <self_service_categories> (plural) with a <size> and one or more <category> nodes.
      // Support both self_service_category and self_service_categories (alias) as inputs.
      const ss = policyData.self_service;
      const toCategoryList = (input: any): Array<{ id?: unknown; name?: unknown }> => {
        if (!input) return [];
        if (typeof input === 'string') {
          const name = input.trim();
          return name ? [{ name }] : [];
        }
        if (Array.isArray(input)) {
          return input
            .flatMap((x) => toCategoryList(x))
            .filter((c) => c && (c.id !== undefined || (typeof c.name === 'string' && c.name.trim())));
        }
        if (typeof input === 'object') {
          // Common shapes:
          // - { id, name }
          // - { category: { id, name } } or { category: [ ... ] }
          if ('category' in (input as any)) {
            return toCategoryList((input as any).category);
          }
          return [
            {
              id: (input as any).id,
              name: (input as any).name,
              // Jamf Classic policy XML commonly includes these on categories.
              display_in: (input as any).display_in ?? (input as any).displayIn,
              feature_in: (input as any).feature_in ?? (input as any).featureIn,
            } as any,
          ];
        }
        return [];
      };

      const categories =
        (ss.self_service_categories !== undefined ? toCategoryList(ss.self_service_categories) : []).length > 0
          ? toCategoryList(ss.self_service_categories)
          : toCategoryList(ss.self_service_category);

      if (categories.length > 0) {
        // Tenant compatibility: some Jamf Classic versions only persist the category selection
        // if the legacy string field <self_service_category> is also present, even when
        // <self_service_categories> is correctly provided.
        const firstName = String((categories[0] as any).name ?? '').trim();
        if (firstName) {
          xml += `    <self_service_category>${escapeXml(firstName)}</self_service_category>\n`;
        }

        xml += '    <self_service_categories>\n';
        xml += `      <size>${categories.length}</size>\n`;
        for (const c of categories) {
          const id = (c as any).id;
          const name = (c as any).name;
          // In practice, Jamf may drop the category if these flags are omitted.
          const displayIn = (c as any).display_in ?? true;
          const featureIn = (c as any).feature_in ?? false;
          xml += '      <category>\n';
          if (id !== undefined && id !== null) xml += `        <id>${escapeXml(String(id))}</id>\n`;
          if (name) xml += `        <name>${escapeXml(String(name))}</name>\n`;
          xml += `        <display_in>${Boolean(displayIn)}</display_in>\n`;
          xml += `        <feature_in>${Boolean(featureIn)}</feature_in>\n`;
          xml += '      </category>\n';
        }
        xml += '    </self_service_categories>\n';
      }

      xml += '  </self_service>\n';
    }

    // Maintenance
    if (policyData.maintenance) {
      xml += '  <maintenance>\n';
      for (const field of POLICY_MAINTENANCE_FIELDS) {
        const value = (policyData.maintenance as any)[field];
        if (value !== undefined) {
          xml += `    <${field}>${Boolean(value)}</${field}>\n`;
        }
      }
      xml += '  </maintenance>\n';
    }
    
    // Package Configuration
    if (policyData.package_configuration) {
      xml += '  <package_configuration>\n';
      if (policyData.package_configuration.packages && policyData.package_configuration.packages.length > 0) {
        xml += '    <packages>\n';
        policyData.package_configuration.packages.forEach((pkg: any) => {
          xml += '      <package>\n';
          xml += `        <id>${pkg.id}</id>\n`;
          if (pkg.action) xml += `        <action>${escapeXml(pkg.action)}</action>\n`;
          if (pkg.fut !== undefined) xml += `        <fut>${pkg.fut}</fut>\n`;
          if (pkg.feu !== undefined) xml += `        <feu>${pkg.feu}</feu>\n`;
          xml += '      </package>\n';
        });
        xml += '    </packages>\n';
      }
      xml += '  </package_configuration>\n';
    }
    
    // Scripts
	    if (policyData.scripts && policyData.scripts.length > 0) {
	      xml += '  <scripts>\n';
	      policyData.scripts.forEach((script: any) => {
	        xml += '    <script>\n';
	        xml += `      <id>${script.id}</id>\n`;
	        if (script.priority) {
	          const normalizedPriority = normalizeScriptPriority(script.priority) ?? String(script.priority);
	          xml += `      <priority>${escapeXml(normalizedPriority)}</priority>\n`;
	        }
	        if (script.parameter4) xml += `      <parameter4>${escapeXml(script.parameter4)}</parameter4>\n`;
	        if (script.parameter5) xml += `      <parameter5>${escapeXml(script.parameter5)}</parameter5>\n`;
	        if (script.parameter6) xml += `      <parameter6>${escapeXml(script.parameter6)}</parameter6>\n`;
	        if (script.parameter7) xml += `      <parameter7>${escapeXml(script.parameter7)}</parameter7>\n`;
        if (script.parameter8) xml += `      <parameter8>${escapeXml(script.parameter8)}</parameter8>\n`;
        if (script.parameter9) xml += `      <parameter9>${escapeXml(script.parameter9)}</parameter9>\n`;
        if (script.parameter10) xml += `      <parameter10>${escapeXml(script.parameter10)}</parameter10>\n`;
        if (script.parameter11) xml += `      <parameter11>${escapeXml(script.parameter11)}</parameter11>\n`;
        xml += '    </script>\n';
      });
      xml += '  </scripts>\n';
    }
    
    xml += '</policy>';
    
    return xml;
  }

  private normalizeScript(script: {
    id?: string | number;
    name?: string;
    category?: string;
    filename?: string;
    info?: string;
    notes?: string;
    priority?: string;
    parameters?: JamfScriptParameters;
    osRequirements?: string;
    os_requirements?: string;
    scriptContents?: string;
    script_contents?: string;
    scriptContentsEncoded?: boolean;
    script_contents_encoded?: boolean;
  }): JamfScriptDetails {
    const normalized: JamfScriptDetails = {
      id: script.id as string | number,
      name: script.name as string,
      category: script.category,
      filename: script.filename,
      info: script.info,
      notes: script.notes,
      priority: script.priority,
      parameters: script.parameters,
      osRequirements: script.osRequirements ?? script.os_requirements,
      scriptContents: script.scriptContents ?? script.script_contents,
      scriptContentsEncoded: script.scriptContentsEncoded ?? script.script_contents_encoded,
    };

    return Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value !== undefined)
    ) as JamfScriptDetails;
  }

  private normalizePackage(pkg: {
    id?: string | number;
    name?: string;
    category?: string;
    filename?: string;
    fileName?: string;
    size?: number;
    priority?: number;
    fill_user_template?: boolean;
    fillUserTemplate?: boolean;
  }): JamfPackage {
    const normalized: JamfPackage = {
      id: pkg.id as string | number,
      name: pkg.name ?? pkg.filename ?? pkg.fileName ?? '',
      category: pkg.category,
      filename: pkg.filename ?? pkg.fileName,
      size: pkg.size,
      priority: pkg.priority,
      fill_user_template: pkg.fill_user_template ?? pkg.fillUserTemplate,
    };

    return Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value !== undefined)
    ) as JamfPackage;
  }

  // Get script details
  async getScriptDetails(scriptId: string): Promise<JamfScriptDetails> {
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info(`Getting script details for ${scriptId} using Modern API...`);
      const response = await this.axiosInstance.get(`/api/v1/scripts/${scriptId}`);
      return this.normalizeScript(response.data);
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
    }
    
    // Try Classic API
    try {
      logger.info(`Getting script details for ${scriptId} using Classic API...`);
      const response = await this.axiosInstance.get(`/JSSResource/scripts/id/${scriptId}`);
      const script = response.data.script;
      return this.normalizeScript(script);
    } catch (error) {
      logger.info(`Failed to get script details for ${scriptId}:`, error);
      throw error;
    }
  }

  /**
   * List all configuration profiles (both Computer and Mobile Device)
   * 
   * Note: The Classic API returns computer configuration profiles under 
   * 'os_x_configuration_profiles' (with underscores), not 'osx_configuration_profiles'.
   * This method handles both field names for compatibility.
   */
  async listConfigurationProfiles(type: 'computer' | 'mobiledevice' = 'computer'): Promise<any[]> {
    await this.ensureAuthenticated();
    
    try {
      // Try Modern API first
      logger.info(`Listing ${type} configuration profiles using Modern API...`);
      const endpoint = type === 'computer' 
        ? '/api/v2/computer-configuration-profiles' 
        : '/api/v2/mobile-device-configuration-profiles';
      
      const response = await this.axiosInstance.get(endpoint);
      return response.data.results || [];
    } catch (error) {
      logger.info(`Modern API failed, trying Classic API...`, {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
      
      // Fall back to Classic API
      try {
        const endpoint = type === 'computer'
          ? '/JSSResource/osxconfigurationprofiles'
          : '/JSSResource/mobiledeviceconfigurationprofiles';
        
        const response = await this.axiosInstance.get(endpoint);
        
        // Debug logging to see response structure
        logger.info(`Classic API response data keys:`, Object.keys(response.data));
        
        // Classic API returns os_x_configuration_profiles (with underscores) for computers
        const profiles = type === 'computer' 
          ? (response.data.os_x_configuration_profiles || response.data.osx_configuration_profiles || [])
          : (response.data.configuration_profiles || response.data.mobiledeviceconfigurationprofiles || []);
        
        logger.info(`Found ${profiles ? profiles.length : 0} ${type} configuration profiles from Classic API`);
        return profiles || [];
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Get configuration profile details
   */
  async getConfigurationProfileDetails(profileId: string, type: 'computer' | 'mobiledevice' = 'computer'): Promise<any> {
    await this.ensureAuthenticated();
    
    try {
      // Try Modern API first
      logger.info(`Getting ${type} configuration profile ${profileId} using Modern API...`);
      const endpoint = type === 'computer'
        ? `/api/v2/computer-configuration-profiles/${profileId}`
        : `/api/v2/mobile-device-configuration-profiles/${profileId}`;
      
      const response = await this.axiosInstance.get(endpoint);
      return response.data;
    } catch (error) {
      logger.info(`Modern API failed, trying Classic API...`, {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
      
      // Fall back to Classic API
      try {
        const endpoint = type === 'computer'
          ? `/JSSResource/osxconfigurationprofiles/id/${profileId}`
          : `/JSSResource/mobiledeviceconfigurationprofiles/id/${profileId}`;
        
        const response = await this.axiosInstance.get(endpoint);
        
        // Debug logging to see response structure
        logger.info(`Classic API response data keys:`, Object.keys(response.data));
        
        // Classic API returns os_x_configuration_profile (with underscores) for computers in detail responses
        const profile = type === 'computer' 
          ? (response.data.os_x_configuration_profile || response.data.osx_configuration_profile)
          : (response.data.configuration_profile || response.data.mobiledeviceconfigurationprofile);
          
        if (!profile) {
          throw new Error(`Profile data not found in response for ${type} profile ${profileId}`);
        }
          
        return profile;
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Search configuration profiles by name
   */
  async searchConfigurationProfiles(query: string, type: 'computer' | 'mobiledevice' = 'computer'): Promise<any[]> {
    const allProfiles = await this.listConfigurationProfiles(type);
    
    // Filter profiles by name (case-insensitive)
    const searchQuery = query.toLowerCase();
    return allProfiles.filter(profile => 
      profile.name?.toLowerCase().includes(searchQuery) ||
      profile.displayName?.toLowerCase().includes(searchQuery)
    );
  }

  /**
   * Deploy configuration profile to devices
   */
  async deployConfigurationProfile(profileId: string, deviceIds: string[], type: 'computer' | 'mobiledevice' = 'computer'): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot deploy configuration profiles in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    // Get current profile details to update scope
    const profile = await this.getConfigurationProfileDetails(profileId, type);
    
    try {
      // Modern API approach - update the profile scope
      logger.info(`Deploying ${type} configuration profile ${profileId} using Modern API...`);
      
      const endpoint = type === 'computer'
        ? `/api/v2/computer-configuration-profiles/${profileId}`
        : `/api/v2/mobile-device-configuration-profiles/${profileId}`;
      
      // Add devices to the profile scope
      const currentScope = profile.scope || {};
      const currentDevices = type === 'computer' 
        ? (currentScope.computerIds || [])
        : (currentScope.mobileDeviceIds || []);
      
      const updatedDeviceIds = [...new Set([...currentDevices, ...deviceIds])];
      
      const updatePayload = {
        ...profile,
        scope: {
          ...currentScope,
          [type === 'computer' ? 'computerIds' : 'mobileDeviceIds']: updatedDeviceIds
        }
      };
      
      await this.axiosInstance.put(endpoint, updatePayload);
      logger.info(`Successfully deployed profile ${profileId} to ${deviceIds.length} ${type}(s)`);
    } catch (error) {
      logger.info(`Modern API failed, trying Classic API...`, {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
      
      // Fall back to Classic API
      try {
        const endpoint = type === 'computer'
          ? `/JSSResource/osxconfigurationprofiles/id/${profileId}`
          : `/JSSResource/mobiledeviceconfigurationprofiles/id/${profileId}`;
        
        // For Classic API, we need to update the scope XML
        const scopeKey = type === 'computer' ? 'computers' : 'mobile_devices';
        const currentDevices = profile.scope?.[scopeKey] || [];
        
        const newDevices = deviceIds.map(id => ({ id: parseInt(id) }));
        const updatedDevices = [...currentDevices, ...newDevices];
        
        const updatePayload = {
          [type === 'computer' ? 'os_x_configuration_profile' : 'configuration_profile']: {
            scope: {
              [scopeKey]: updatedDevices
            }
          }
        };
        
        await this.axiosInstance.put(endpoint, updatePayload);
        logger.info(`Successfully deployed profile ${profileId} to ${deviceIds.length} ${type}(s) via Classic API`);
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Remove configuration profile from devices
   */
  async removeConfigurationProfile(profileId: string, deviceIds: string[], type: 'computer' | 'mobiledevice' = 'computer'): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot remove configuration profiles in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    // Get current profile details to update scope
    const profile = await this.getConfigurationProfileDetails(profileId, type);
    
    try {
      // Modern API approach - update the profile scope
      logger.info(`Removing ${type} configuration profile ${profileId} using Modern API...`);
      
      const endpoint = type === 'computer'
        ? `/api/v2/computer-configuration-profiles/${profileId}`
        : `/api/v2/mobile-device-configuration-profiles/${profileId}`;
      
      // Remove devices from the profile scope
      const currentScope = profile.scope || {};
      const currentDevices = type === 'computer' 
        ? (currentScope.computerIds || [])
        : (currentScope.mobileDeviceIds || []);
      
      const updatedDeviceIds = currentDevices.filter((id: string) => !deviceIds.includes(String(id)));
      
      const updatePayload = {
        ...profile,
        scope: {
          ...currentScope,
          [type === 'computer' ? 'computerIds' : 'mobileDeviceIds']: updatedDeviceIds
        }
      };
      
      await this.axiosInstance.put(endpoint, updatePayload);
      logger.info(`Successfully removed profile ${profileId} from ${deviceIds.length} ${type}(s)`);
    } catch (error) {
      logger.info(`Modern API failed, trying Classic API...`, {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
      
      // Fall back to Classic API
      try {
        const endpoint = type === 'computer'
          ? `/JSSResource/osxconfigurationprofiles/id/${profileId}`
          : `/JSSResource/mobiledeviceconfigurationprofiles/id/${profileId}`;
        
        // For Classic API, we need to update the scope XML
        const scopeKey = type === 'computer' ? 'computers' : 'mobile_devices';
        const currentDevices = profile.scope?.[scopeKey] || [];
        
        const deviceIdsToRemove = deviceIds.map(id => parseInt(id));
        const updatedDevices = currentDevices.filter((device: any) => 
          !deviceIdsToRemove.includes(device.id)
        );
        
        const updatePayload = {
          [type === 'computer' ? 'os_x_configuration_profile' : 'configuration_profile']: {
            scope: {
              [scopeKey]: updatedDevices
            }
          }
        };
        
        await this.axiosInstance.put(endpoint, updatePayload);
        logger.info(`Successfully removed profile ${profileId} from ${deviceIds.length} ${type}(s) via Classic API`);
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * List all packages
   */
  async listPackages(limit: number = 100): Promise<JamfPackage[]> {
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info('Listing packages using Modern API...');
      const response = await this.axiosInstance.get('/api/v1/packages', {
        params: { 'page-size': limit },
      });
      const packages = response.data?.results || response.data?.packages || [];
      return packages.map((pkg: JamfPackage) => this.normalizePackage(pkg));
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
      try {
        logger.info('Listing packages using Classic API...');
        const response = await this.axiosInstance.get('/JSSResource/packages');
        const packages = response.data.packages || [];
        return packages.slice(0, limit).map((pkg: JamfPackage) => this.normalizePackage(pkg));
      } catch (classicError) {
        logger.info('Failed to list packages:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Get package details
   */
  async getPackageDetails(packageId: string): Promise<JamfPackage> {
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info(`Getting package details for ${packageId} using Modern API...`);
      const response = await this.axiosInstance.get(`/api/v1/packages/${packageId}`);
      return this.normalizePackage(response.data);
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
      try {
        logger.info(`Getting package details for ${packageId} using Classic API...`);
        const response = await this.axiosInstance.get(`/JSSResource/packages/id/${packageId}`);
        return this.normalizePackage(response.data.package);
      } catch (classicError) {
        logger.info('Failed to get package details:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Search packages by name
   */
  async searchPackages(query: string, limit: number = 100): Promise<any[]> {
    await this.ensureAuthenticated();
    
    // Packages are only available through Classic API
    try {
      logger.info('Searching packages using Classic API...');
      const response = await this.axiosInstance.get('/JSSResource/packages');
      const packages = response.data.packages || [];
      
      if (!query) {
        return packages.slice(0, limit);
      }
      
      const lowerQuery = query.toLowerCase();
      const filtered = packages.filter((p: any) => 
        p.name?.toLowerCase().includes(lowerQuery) ||
        p.filename?.toLowerCase().includes(lowerQuery) ||
        p.category?.toLowerCase().includes(lowerQuery)
      );
      
      return filtered.slice(0, limit);
    } catch (error) {
      logger.info('Failed to search packages:', error);
      throw error;
    }
  }

  /**
   * Get package deployment history
   */
  async getPackageDeploymentHistory(packageId: string): Promise<any> {
    await this.ensureAuthenticated();
    
    try {
      // Package deployment history is typically tracked through policies
      // First get the package details to understand its usage
      const packageDetails = await this.getPackageDetails(packageId);
      
      // Get all policies and filter those using this package
      const policies = await this.listPolicies(1000);
      const policiesUsingPackage: any[] = [];
      
      // Check each policy to see if it uses this package
      for (const policy of policies) {
        try {
          const policyDetails = await this.getPolicyDetails(policy.id);
          const packagesInPolicy = policyDetails.package_configuration?.packages || [];
          
          if (packagesInPolicy.some((p: any) => String(p.id) === String(packageId))) {
            policiesUsingPackage.push({
              policyId: policy.id,
              policyName: policy.name,
              enabled: policyDetails.general?.enabled,
              frequency: policyDetails.general?.frequency,
              targetedDevices: policyDetails.scope?.computers?.length || 0,
              lastModified: policyDetails.general?.date_time_limitations?.activation_date,
            });
          }
        } catch (err) {
          logger.info(`Failed to get details for policy ${policy.id}:`, err);
        }
      }
      
      return {
        package: {
          id: packageDetails.id,
          name: packageDetails.name || packageDetails.filename,
          category: packageDetails.category,
          size: packageDetails.size,
        },
        deploymentInfo: {
          policiesUsingPackage: policiesUsingPackage.length,
          policies: policiesUsingPackage,
        },
      };
    } catch (error) {
      logger.info('Failed to get package deployment history:', error);
      throw error;
    }
  }

  /**
   * Get policies using a specific package
   */
  async getPoliciesUsingPackage(packageId: string): Promise<any[]> {
    await this.ensureAuthenticated();
    
    try {
      // Get all policies
      const policies = await this.listPolicies(1000);
      const policiesUsingPackage: any[] = [];
      
      // Check each policy to see if it uses this package
      for (const policy of policies) {
        try {
          const policyDetails = await this.getPolicyDetails(policy.id);
          const packagesInPolicy = policyDetails.package_configuration?.packages || [];
          
          if (packagesInPolicy.some((p: any) => String(p.id) === String(packageId))) {
            policiesUsingPackage.push({
              id: policy.id,
              name: policy.name,
              enabled: policyDetails.general?.enabled,
              frequency: policyDetails.general?.frequency,
              category: policyDetails.category,
              targetedComputers: policyDetails.scope?.computers?.length || 0,
              targetedComputerGroups: policyDetails.scope?.computer_groups?.length || 0,
              packageAction: packagesInPolicy.find((p: any) => String(p.id) === String(packageId))?.action || 'Install',
            });
          }
        } catch (err) {
          logger.info(`Failed to get details for policy ${policy.id}:`, err);
        }
      }
      
      return policiesUsingPackage;
    } catch (error) {
      logger.info('Failed to get policies using package:', error);
      throw error;
    }
  }

  /**
   * List computer groups
   */
  async listComputerGroups(type: 'smart' | 'static' | 'all' = 'all'): Promise<any[]> {
    await this.ensureAuthenticated();
    
    // Computer groups are only available through Classic API
    try {
      logger.info(`Listing computer groups (${type}) using Classic API...`);
      const response = await this.axiosInstance.get('/JSSResource/computergroups');
      let groups = response.data.computer_groups || [];
      
      // Classic API doesn't provide group type in list, so we need to fetch each one
      // For performance, only do this if filtering is requested
      if (type !== 'all' && groups.length > 0) {
        const detailedGroups = [];
        for (const group of groups) {
          try {
            const details = await this.getComputerGroupDetails(group.id.toString());
            if ((type === 'smart' && details.is_smart) || 
                (type === 'static' && !details.is_smart)) {
              detailedGroups.push({
                ...group,
                is_smart: details.is_smart,
                size: details.computers?.length || 0
              });
            }
          } catch (err) {
            logger.info(`Failed to get details for group ${group.id}:`, err);
          }
        }
        groups = detailedGroups;
      }
      
      return groups;
    } catch (error) {
      logger.info('Failed to list computer groups:', error);
      throw error;
    }
  }

  /**
   * Get computer group details
   */
  async getComputerGroupDetails(groupId: string): Promise<any> {
    await this.ensureAuthenticated();
    
    // Computer groups are only available through Classic API
    try {
      logger.info(`Getting computer group ${groupId} details using Classic API...`);
      const response = await this.axiosInstance.get(`/JSSResource/computergroups/id/${groupId}`);
      const group = response.data.computer_group;
      
      // Transform Classic API response to include member count
      return {
        id: group.id,
        name: group.name,
        is_smart: group.is_smart,
        criteria: group.criteria,
        computers: group.computers || [],
        site: group.site,
        memberCount: group.computers?.length || 0,
      };
    } catch (error) {
      logger.info('Failed to get computer group details:', error);
      throw error;
    }
  }

  /**
   * Search computer groups by name
   */
  async searchComputerGroups(query: string): Promise<any[]> {
    const allGroups = await this.listComputerGroups('all');
    
    if (!query) {
      return allGroups;
    }
    
    const lowerQuery = query.toLowerCase();
    return allGroups.filter(group => 
      group.name?.toLowerCase().includes(lowerQuery) ||
      group.id?.toString().includes(query)
    );
  }

  /**
   * Get computer group members
   */
  async getComputerGroupMembers(groupId: string): Promise<any[]> {
    const groupDetails = await this.getComputerGroupDetails(groupId);
    
    // Return the computers array from the group details
    return groupDetails.computers || [];
  }

	  private normalizeSmartGroupCriteria(
    criteriaInput:
      | SmartGroupCriteriaInput[]
      | SmartGroupCriteriaContainer
      | null
      | undefined
	  ): JamfSearchCriteria[] {
	    if (!criteriaInput) return [];

    let criteriaList: SmartGroupCriteriaInput[] = [];

    if (Array.isArray(criteriaInput)) {
      criteriaList = criteriaInput;
    } else if (typeof criteriaInput === 'object') {
      if (Array.isArray(criteriaInput.criterion)) {
        criteriaList = criteriaInput.criterion;
      } else if (Array.isArray(criteriaInput.criteria)) {
        criteriaList = criteriaInput.criteria;
      }
    }

	    return criteriaList
	      .map((criterion) =>
	        normalizeSmartGroupCriterion({
	          name: criterion.name,
	          priority: criterion.priority,
	          and_or: criterion.and_or ?? criterion.andOr,
	          search_type: criterion.search_type ?? criterion.searchType,
	          value: criterion.value,
	          opening_paren: criterion.opening_paren,
	          closing_paren: criterion.closing_paren,
	        })
	      )
	      .map((criterion) => {
	        const andOrRaw = String(criterion.and_or ?? '').trim();
	        const andOr = andOrRaw === 'and' || andOrRaw === 'or' ? andOrRaw : undefined;
	        return {
	          name: String(criterion.name ?? ''),
	          priority: Number(criterion.priority ?? 0),
	          and_or: andOr,
	          search_type: String(criterion.search_type ?? ''),
	          value: String(criterion.value ?? ''),
	          opening_paren: criterion.opening_paren as any,
	          closing_paren: criterion.closing_paren as any,
	        } as JamfSearchCriteria;
	      })
	      .filter((criterion) => this.isValidSmartGroupCriterion(criterion));
	  }

  private isValidSmartGroupCriterion(criterion: JamfSearchCriteria): boolean {
    const name = typeof criterion.name === 'string' ? criterion.name.trim() : '';
    const andOr = typeof criterion.and_or === 'string' ? criterion.and_or.trim() : '';
    const searchType = typeof criterion.search_type === 'string' ? criterion.search_type.trim() : '';
    const value = typeof criterion.value === 'string' ? criterion.value.trim() : '';

    return name !== '' && andOr !== '' && searchType !== '' && value !== '';
  }

  /**
   * Build Modern API payload for smart computer groups
   */
  private normalizeModernSmartGroupSearchType(
    criterionName: string | undefined,
    searchType: string | undefined,
    value: string | undefined
  ): string | undefined {
    if (!criterionName || !searchType) return searchType;

    const name = criterionName.trim().toLowerCase();
    const st = searchType.trim().toLowerCase();
    const v = (value ?? '').trim().toLowerCase();

    // Jamf's Modern smart-groups endpoint validates operators per criterion. The Classic API accepts
    // some operators (like "like") that are rejected for specific criteria in Modern.
    // Example: "Application Title" rejects operator "like" (HTTP 400 INVALID_FIELD).
    if (name === 'application title') {
      if (st === 'like') {
        // Most user intents here are exact app bundle-name matches (e.g. "timeBuzzer.app").
        // Use the stricter operator that Modern accepts.
        return 'is';
      }
      if (st === 'contains') {
        // Some callers use "contains" interchangeably with Classic "like".
        // Prefer an operator that Modern accepts for this criterion.
        return v.endsWith('.app') ? 'is' : 'is';
      }
    }

    return searchType;
  }

  private buildModernSmartGroupPayload(
    name: string,
    criteria: JamfSearchCriteria[],
    siteId?: number
  ): Record<string, unknown> {
    const mappedCriteria = criteria.map((criterion) => ({
      name: criterion.name,
      priority: criterion.priority,
      andOr: criterion.and_or,
      searchType: this.normalizeModernSmartGroupSearchType(
        criterion.name,
        criterion.search_type,
        criterion.value
      ),
      value: criterion.value,
    }));

    return {
      name,
      criteria: mappedCriteria,
      ...(siteId !== undefined ? { siteId } : {}),
    };
  }

  private buildModernStaticGroupPayload(
    name: string,
    computerIds: number[]
  ): { name: string; computerIds: number[] } {
    return {
      name,
      computerIds,
    };
  }

  private normalizeComputerIds(computerIds: string[]): number[] {
    return computerIds
      .map((id) => (typeof id === 'string' ? id.trim() : String(id).trim()))
      .filter((id) => id !== '' && /^\d+$/.test(id))
      .map((id) => Number(id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
  }

  /**
   * Build Classic API XML payload for smart computer groups
   */
  private buildClassicSmartGroupXml(
    name: string,
    criteria: SmartGroupCriteriaInput[] | SmartGroupCriteriaContainer | null | undefined,
    siteId?: number
  ): string {
    const normalizedCriteria = this.normalizeSmartGroupCriteria(criteria);
    const mappedCriteria = normalizedCriteria
      .map((criterion) => {
        const normalized = normalizeSmartGroupCriterion(criterion);
        const andOrValue = normalized.and_or ?? '';
        const searchTypeValue = normalized.search_type ?? '';
        const priorityValue = normalized.priority ?? '';
        const valueValue = normalized.value ?? '';
        const nameValue = normalized.name ?? '';

        return `
	    <criterion>
	      <name>${this.escapeXml(String(nameValue))}</name>
      <priority>${this.escapeXml(String(priorityValue))}</priority>
      <and_or>${this.escapeXml(String(andOrValue))}</and_or>
      <search_type>${this.escapeXml(String(searchTypeValue))}</search_type>
      <value>${this.escapeXml(String(valueValue))}</value>
    </criterion>`;
      })
      .join('');

    const siteXml =
      siteId !== undefined
        ? `
  <site>
    <id>${siteId}</id>
  </site>`
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<computer_group>
  <name>${this.escapeXml(name)}</name>
  <is_smart>true</is_smart>${siteXml}
  <criteria>${mappedCriteria}
  </criteria>
</computer_group>`;
  }

  /**
   * Create smart computer group
   */
  async createSmartComputerGroup(
    name: string,
    criteria: SmartGroupCriteriaInput[],
    siteId?: number
  ): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create computer groups in read-only mode');
    }

    await this.ensureAuthenticated();

    const normalizedCriteria = this.normalizeSmartGroupCriteria(criteria);
    if (normalizedCriteria.length === 0) {
      throw new Error('Smart group criteria cannot be empty');
    }

    // Try Modern API first
    try {
      logger.info(`Creating smart computer group "${name}" using Modern API...`);

      const modernPayload = this.buildModernSmartGroupPayload(name, normalizedCriteria, siteId);
      const response = await this.axiosInstance.post('/api/v2/computer-groups/smart-groups', modernPayload);
      const createdId = response.data?.id ? String(response.data.id) : null;

      if (createdId) {
        // Prefer Classic details (includes criteria + members), but don't fail the create if Classic auth isn't available.
        try {
          return await this.getComputerGroupDetails(createdId);
        } catch (detailsError) {
          logger.info('Created smart group via Modern API, but failed to fetch Classic details; returning Modern response', {
            status: getAxiosErrorStatus(detailsError),
            data: getAxiosErrorData(detailsError),
          });
          return response.data ?? { id: createdId, name };
        }
      }

      return response.data;
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        // Surface Modern errors directly to avoid masking validation errors with Classic 401s.
        throw error;
      }

      logger.info('Falling back to Classic API for smart group create', {
        canCallClassicApi: this.canCallClassicApi(),
        status: getAxiosErrorStatus(error),
      });

      // Fall back to Classic API
      try {
        const xmlPayload = this.buildClassicSmartGroupXml(name, criteria, siteId);
        const response = await this.axiosInstance.post(
          '/JSSResource/computergroups/id/0',
          xmlPayload,
          {
            headers: {
              'Content-Type': 'application/xml',
              'Accept': 'application/xml',
            }
          }
        );
        const createdId = response.data?.id ? String(response.data.id) : null;

        if (createdId) {
          return await this.getComputerGroupDetails(createdId);
        }

        return response.data;
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Update smart computer group
   */
  async updateSmartComputerGroup(
    groupId: string,
    updates: { name?: string; criteria?: SmartGroupCriteriaInput[]; siteId?: number }
  ): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update computer groups in read-only mode');
    }

    await this.ensureAuthenticated();

    const groupDetails = await this.getComputerGroupDetails(groupId);
    const newName = updates.name ?? groupDetails.name;
    const newCriteria = this.normalizeSmartGroupCriteria(updates.criteria ?? groupDetails.criteria);
    if (newCriteria.length === 0) {
      throw new Error('Smart group criteria cannot be empty');
    }
    const resolvedSiteId = updates.siteId ?? groupDetails.site?.id;

    // Try Modern API first
    try {
      logger.info(`Updating smart computer group ${groupId} using Modern API...`);

      const modernPayload = this.buildModernSmartGroupPayload(newName, newCriteria, resolvedSiteId);
      const response = await this.axiosInstance.put(
        `/api/v2/computer-groups/smart-groups/${groupId}`,
        modernPayload
      );

      return response.data;
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }

      logger.info('Falling back to Classic API for smart group update', {
        canCallClassicApi: this.canCallClassicApi(),
        status: getAxiosErrorStatus(error),
      });

      // Fall back to Classic API
      try {
        const xmlPayload = this.buildClassicSmartGroupXml(newName, newCriteria, resolvedSiteId);
        const response = await this.axiosInstance.put(
          `/JSSResource/computergroups/id/${groupId}`,
          xmlPayload,
          {
            headers: {
              'Content-Type': 'application/xml',
              'Accept': 'application/xml',
            }
          }
        );

        return response.data;
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Create static computer group
   */
  async createStaticComputerGroup(name: string, computerIds: string[]): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create computer groups in read-only mode');
    }
    
    await this.ensureAuthenticated();

    const normalizedComputerIds = this.normalizeComputerIds(computerIds);
    if (normalizedComputerIds.length === 0) {
      throw new Error('Static group computer IDs cannot be empty');
    }
    
    try {
      // Try Modern API first
      logger.info(`Creating static computer group "${name}" using Modern API...`);

      const payload = this.buildModernStaticGroupPayload(name, normalizedComputerIds);
      const response = await this.axiosInstance.post('/api/v2/computer-groups/static-groups', payload);
      const createdId = response.data?.id ? String(response.data.id) : null;

      if (createdId) {
        return await this.getComputerGroupDetails(createdId);
      }

      return response.data;
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
      
      // Fall back to Classic API
      try {
        const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<computer_group>
  <name>${this.escapeXml(name)}</name>
  <is_smart>false</is_smart>
  <computers>
    ${normalizedComputerIds.map(id => `<computer><id>${this.escapeXml(String(id))}</id></computer>`).join('\n    ')}
  </computers>
</computer_group>`;

        const response = await this.axiosInstance.post(
          '/JSSResource/computergroups/id/0',
          xmlPayload,
          {
            headers: {
              'Content-Type': 'application/xml',
              'Accept': 'application/xml',
            }
          }
        );
        return response.data.computer_group;
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Update static computer group membership
   */
  async updateStaticComputerGroup(groupId: string, computerIds: string[]): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update computer groups in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    // First get the group details to ensure it's a static group
    const groupDetails = await this.getComputerGroupDetails(groupId);
    if (groupDetails.is_smart || groupDetails.isSmart) {
      throw new Error('Cannot update membership of a smart group. Smart groups are defined by criteria.');
    }

    const normalizedComputerIds = this.normalizeComputerIds(computerIds);
    if (normalizedComputerIds.length === 0) {
      throw new Error('Static group computer IDs cannot be empty');
    }

    // Try Modern API first
    try {
      logger.info(`Updating static computer group ${groupId} using Modern API...`);

      const payload = this.buildModernStaticGroupPayload(groupDetails.name, normalizedComputerIds);
      const response = await this.axiosInstance.put(
        `/api/v2/computer-groups/static-groups/${groupId}`,
        { name: payload.name, computerIds: payload.computerIds }
      );

      return response.data;
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
      
      // Classic API requires XML format for updates
      try {
        logger.info(`Updating static computer group ${groupId} using Classic API with XML...`);
        
        // Build XML payload
        const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<computer_group>
  <name>${this.escapeXml(groupDetails.name)}</name>
  <is_smart>false</is_smart>
  <computers>
    ${normalizedComputerIds.map(id => `<computer><id>${this.escapeXml(String(id))}</id></computer>`).join('\n    ')}
  </computers>
</computer_group>`;
        
        logger.info('Sending XML payload:', xmlPayload);
        
        const response = await this.axiosInstance.put(
          `/JSSResource/computergroups/id/${groupId}`,
          xmlPayload,
          {
            headers: {
              'Content-Type': 'application/xml',
              'Accept': 'application/xml',
            }
          }
        );
        
        // The Classic API returns XML, but might also return an empty response on success
        // Let's return the updated group details by fetching them
        logger.info('Update request completed, fetching updated group details...');
        try {
          const updatedGroup = await this.getComputerGroupDetails(groupId);
          return updatedGroup;
        } catch (fetchError) {
          // If we can't fetch the updated details, just return a success indicator
          logger.info('Could not fetch updated group details, but update likely succeeded');
          return { id: groupId, success: true };
        }
      } catch (classicError) {
        logger.info('Failed to update computer group:', getAxiosErrorStatus(classicError), getAxiosErrorData(classicError));
        throw classicError;
      }
    }
  }

  /**
   * Delete computer group
   */
  async deleteComputerGroup(groupId: string): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot delete computer groups in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    try {
      // Try Modern API first
      logger.info(`Deleting computer group ${groupId} using Modern API...`);
      await this.axiosInstance.delete(`/api/v1/computer-groups/${groupId}`);
      logger.info(`Successfully deleted computer group ${groupId}`);
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
      
      // Fall back to Classic API
      try {
        await this.axiosInstance.delete(`/JSSResource/computergroups/id/${groupId}`);
        logger.info(`Successfully deleted computer group ${groupId} via Classic API`);
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Search mobile devices
   */
  async searchMobileDevices(query: string, limit: number = 100): Promise<any[]> {
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info('Searching mobile devices using Modern API...');
      const response = await this.axiosInstance.get('/api/v2/mobile-devices', {
        params: {
          'page-size': limit,
          'filter': query ? `name=="*${query}*",serialNumber=="*${query}*",udid=="*${query}*"` : undefined,
        },
      });
      
      return response.data.results || [];
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
    }
    
    // Try Classic API
    try {
      logger.info('Searching mobile devices using Classic API...');
      if (query) {
        const response = await this.axiosInstance.get(`/JSSResource/mobiledevices/match/*${query}*`);
        const devices = response.data.mobile_devices || [];
        return devices.slice(0, limit);
      } else {
        const response = await this.axiosInstance.get('/JSSResource/mobiledevices');
        const devices = response.data.mobile_devices || [];
        return devices.slice(0, limit);
      }
    } catch (error) {
      logger.info('Classic API search failed:', error);
      throw error;
    }
  }

  /**
   * Get mobile device details
   */
  async getMobileDeviceDetails(deviceId: string): Promise<any> {
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info(`Getting mobile device details for ${deviceId} using Modern API...`);
      const response = await this.axiosInstance.get(`/api/v2/mobile-devices/${deviceId}/detail`);
      return response.data;
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
    }
    
    // Try Classic API
    try {
      logger.info(`Getting mobile device details for ${deviceId} using Classic API...`);
      const response = await this.axiosInstance.get(`/JSSResource/mobiledevices/id/${deviceId}`);
      return response.data.mobile_device;
    } catch (error) {
      logger.info('Classic API failed:', error);
      throw error;
    }
  }

  /**
   * List all mobile devices
   */
  async listMobileDevices(limit: number = 100): Promise<any[]> {
    return this.searchMobileDevices('', limit);
  }

  /**
   * Update mobile device inventory
   */
  async updateMobileDeviceInventory(deviceId: string): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update mobile device inventory in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info(`Updating mobile device inventory for ${deviceId} using Modern API...`);
      await this.axiosInstance.post(`/api/v2/mobile-devices/${deviceId}/update-inventory`);
      logger.info(`Mobile device inventory update requested for device ${deviceId}`);
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
      
      // Try Classic API using MDM commands
      try {
        // Classic API expects XML format for MDM commands
        const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<mobile_device_command>
  <general>
    <command>UpdateInventory</command>
  </general>
  <mobile_devices>
    <mobile_device>
      <id>${deviceId}</id>
    </mobile_device>
  </mobile_devices>
</mobile_device_command>`;
        
        await this.axiosInstance.post(
          `/JSSResource/mobiledevicecommands/command/UpdateInventory/id/${deviceId}`,
          xmlPayload,
          {
            headers: {
              'Content-Type': 'application/xml',
              'Accept': 'application/xml',
            }
          }
        );
        logger.info(`Mobile device inventory update requested for device ${deviceId} via Classic API`);
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Send MDM command to mobile device
   */
  async sendMDMCommand(deviceId: string, command: string): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot send MDM commands in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    // Validate command
    const validCommands = [
      'DeviceLock',
      'EraseDevice',
      'ClearPasscode',
      'RestartDevice',
      'ShutDownDevice',
      'EnableLostMode',
      'DisableLostMode',
      'PlayLostModeSound',
      'UpdateInventory',
      'ClearRestrictionsPassword',
      'SettingsEnableBluetooth',
      'SettingsDisableBluetooth',
      'SettingsEnableWiFi',
      'SettingsDisableWiFi',
      'SettingsEnableDataRoaming',
      'SettingsDisableDataRoaming',
      'SettingsEnableVoiceRoaming',
      'SettingsDisableVoiceRoaming',
      'SettingsEnablePersonalHotspot',
      'SettingsDisablePersonalHotspot'
    ];
    
    if (!validCommands.includes(command)) {
      throw new Error(`Invalid MDM command: ${command}. Valid commands are: ${validCommands.join(', ')}`);
    }
    
    // Try Modern API first
    try {
      logger.info(`Sending MDM command '${command}' to mobile device ${deviceId} using Modern API...`);
      
      // Modern API uses different endpoints for different commands
      if (command === 'DeviceLock') {
        await this.axiosInstance.post(`/api/v2/mobile-devices/${deviceId}/lock`);
      } else if (command === 'EraseDevice') {
        await this.axiosInstance.post(`/api/v2/mobile-devices/${deviceId}/erase`);
      } else if (command === 'ClearPasscode') {
        await this.axiosInstance.post(`/api/v2/mobile-devices/${deviceId}/clear-passcode`);
      } else {
        // Generic command endpoint
        await this.axiosInstance.post(`/api/v2/mobile-devices/${deviceId}/commands`, {
          commandType: command,
        });
      }
      
      logger.info(`Successfully sent MDM command '${command}' to device ${deviceId}`);
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
      
      // Try Classic API
      try {
        await this.axiosInstance.post(`/JSSResource/mobiledevicecommands/command/${command}`, {
          mobile_device_id: deviceId,
        });
        logger.info(`Successfully sent MDM command '${command}' to device ${deviceId} via Classic API`);
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * List all scripts
   */
  async listScripts(limit: number = 100): Promise<JamfScriptDetails[]> {
    await this.ensureAuthenticated();
    
    // Try Modern API first
    try {
      logger.info('Listing scripts using Modern API...');
      const response = await this.axiosInstance.get('/api/v1/scripts', {
        params: {
          page: 0,
          'page-size': Math.min(limit, 2000),
        },
      });
      const scripts = response.data.results || [];
      return scripts.map((script: JamfScriptDetails) => this.normalizeScript(script));
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
    }

    // Fall back to Classic API
    try {
      logger.info('Listing scripts using Classic API...');
      const response = await this.axiosInstance.get('/JSSResource/scripts');
      const scripts = response.data.scripts || [];
      return scripts.slice(0, limit).map((script: JamfScriptDetails) => this.normalizeScript(script));
    } catch (error) {
      logger.info('Failed to list scripts:', error);
      throw error;
    }
  }

  /**
   * Search scripts by name
   */
  async searchScripts(query: string, limit: number = 100): Promise<any[]> {
    await this.ensureAuthenticated();
    
    // Scripts are only available through Classic API
    try {
      logger.info('Searching scripts using Classic API...');
      const response = await this.axiosInstance.get('/JSSResource/scripts');
      const scripts = response.data.scripts || [];
      
      if (!query) {
        return scripts.slice(0, limit);
      }
      
      const lowerQuery = query.toLowerCase();
      const filtered = scripts.filter((s: any) => 
        s.name?.toLowerCase().includes(lowerQuery) ||
        s.id?.toString().includes(query)
      );
      
      return filtered.slice(0, limit);
    } catch (error) {
      logger.info('Failed to search scripts:', error);
      throw error;
    }
  }

  /**
   * Create a new script
   */
  async createScript(scriptData: JamfScriptCreateInput): Promise<JamfScriptDetails> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create scripts in read-only mode');
    }
    
    await this.ensureAuthenticated();

    const modernPayload = {
      name: scriptData.name,
      category: scriptData.category,
      info: scriptData.info,
      notes: scriptData.notes,
      priority: scriptData.priority,
      scriptContents: scriptData.script_contents,
      scriptContentsEncoded: scriptData.script_contents_encoded,
      parameters: scriptData.parameters,
      osRequirements: scriptData.os_requirements,
    };

    // Try Modern API first
    try {
      logger.info('Creating script using Modern API...');
      const response = await this.axiosInstance.post('/api/v1/scripts', modernPayload);
      if (response.data?.id) {
        return await this.getScriptDetails(String(response.data.id));
      }
      return this.normalizeScript(response.data);
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
    }

    // Fall back to Classic API
    try {
      logger.info('Creating script using Classic API with XML...');

      // Build XML payload
      const xmlPayload = this.buildScriptXml(scriptData);
      logger.info('Classic script XML payload prepared', {
        name: scriptData.name ?? 'unknown',
      });

      const response = await this.axiosInstance.post(
        '/JSSResource/scripts/id/0',
        xmlPayload,
        {
          headers: {
            'Content-Type': 'application/xml',
            'Accept': 'application/xml',
          }
        }
      );

      // Extract the created script ID from the response
      const locationHeader = response.headers.location;
      const scriptId = locationHeader ? locationHeader.split('/').pop() : null;

      if (!scriptId) {
        throw new Error('Classic API did not return a script id for the created script');
      }

      // Fetch and return the created script details
      return await this.getScriptDetails(scriptId);
    } catch (error) {
      logger.info('Failed to create script:', error);
      throw error;
    }
  }

  /**
   * Update an existing script
   */
  async updateScript(scriptId: string, scriptData: JamfScriptUpdateInput): Promise<JamfScriptDetails> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update scripts in read-only mode');
    }
    
    await this.ensureAuthenticated();

    const modernPayload = {
      name: scriptData.name,
      category: scriptData.category,
      info: scriptData.info,
      notes: scriptData.notes,
      priority: scriptData.priority,
      scriptContents: scriptData.script_contents,
      scriptContentsEncoded: scriptData.script_contents_encoded,
      parameters: scriptData.parameters,
      osRequirements: scriptData.os_requirements,
    };

    // Try Modern API first
    try {
      logger.info(`Updating script ${scriptId} using Modern API...`);
      const response = await this.axiosInstance.put(`/api/v1/scripts/${scriptId}`, modernPayload);
      if (response.data?.id) {
        const updatedScript = await this.getScriptDetails(String(response.data.id));
        return await this.verifyScriptUpdatePersisted(String(response.data.id), scriptData, updatedScript);
      }
      const normalizedScript = this.normalizeScript(response.data);
      return await this.verifyScriptUpdatePersisted(scriptId, scriptData, normalizedScript);
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
    }

    // Fall back to Classic API
    try {
      logger.info(`Updating script ${scriptId} using Classic API with XML...`);

      // Build XML payload
      const xmlPayload = this.buildScriptXml(scriptData);

      await this.axiosInstance.put(
        `/JSSResource/scripts/id/${scriptId}`,
        xmlPayload,
        {
          headers: {
            'Content-Type': 'application/xml',
            'Accept': 'application/xml',
          }
        }
      );

      // Fetch and return the updated script details
      const updatedScript = await this.getScriptDetails(scriptId);
      return await this.verifyScriptUpdatePersisted(scriptId, scriptData, updatedScript);
    } catch (error) {
      logger.info('Failed to update script:', error);
      throw error;
    }
  }

  /**
   * Delete a script
   */
  async deleteScript(scriptId: string): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot delete scripts in read-only mode');
    }
    
    await this.ensureAuthenticated();

    // Try Modern API first
    try {
      logger.info(`Deleting script ${scriptId} using Modern API...`);
      await this.axiosInstance.delete(`/api/v1/scripts/${scriptId}`);
      logger.info(`Successfully deleted script ${scriptId}`);
      return;
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });
      if (!this.shouldFallbackToClassicOnModernError(error)) {
        throw error;
      }
    }

    // Fall back to Classic API
    try {
      logger.info(`Deleting script ${scriptId} using Classic API...`);
      await this.axiosInstance.delete(`/JSSResource/scripts/id/${scriptId}`);
      logger.info(`Successfully deleted script ${scriptId}`);
    } catch (error) {
      logger.info('Failed to delete script:', error);
      throw error;
    }
  }

  /**
   * Build XML payload for script creation/update
   */
  private buildScriptXml(scriptData: JamfScriptCreateInput | JamfScriptUpdateInput): string {
    const escapeXml = (str: string): string => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };
    
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<script>\n';
    
    // Basic script information
    if (scriptData.name) xml += `  <name>${escapeXml(scriptData.name)}</name>\n`;
    if (scriptData.category) xml += `  <category>${escapeXml(scriptData.category)}</category>\n`;
    if (scriptData.filename) xml += `  <filename>${escapeXml(scriptData.filename)}</filename>\n`;
    if (scriptData.info) xml += `  <info>${escapeXml(scriptData.info)}</info>\n`;
    if (scriptData.notes) xml += `  <notes>${escapeXml(scriptData.notes)}</notes>\n`;
    if (scriptData.priority) {
      const normalizedPriority = normalizeScriptPriority(scriptData.priority) ?? String(scriptData.priority);
      xml += `  <priority>${escapeXml(normalizedPriority)}</priority>\n`;
    }
    
    // Parameters
    if (scriptData.parameters) {
      xml += '  <parameters>\n';
      if (scriptData.parameters.parameter4) xml += `    <parameter4>${escapeXml(scriptData.parameters.parameter4)}</parameter4>\n`;
      if (scriptData.parameters.parameter5) xml += `    <parameter5>${escapeXml(scriptData.parameters.parameter5)}</parameter5>\n`;
      if (scriptData.parameters.parameter6) xml += `    <parameter6>${escapeXml(scriptData.parameters.parameter6)}</parameter6>\n`;
      if (scriptData.parameters.parameter7) xml += `    <parameter7>${escapeXml(scriptData.parameters.parameter7)}</parameter7>\n`;
      if (scriptData.parameters.parameter8) xml += `    <parameter8>${escapeXml(scriptData.parameters.parameter8)}</parameter8>\n`;
      if (scriptData.parameters.parameter9) xml += `    <parameter9>${escapeXml(scriptData.parameters.parameter9)}</parameter9>\n`;
      if (scriptData.parameters.parameter10) xml += `    <parameter10>${escapeXml(scriptData.parameters.parameter10)}</parameter10>\n`;
      if (scriptData.parameters.parameter11) xml += `    <parameter11>${escapeXml(scriptData.parameters.parameter11)}</parameter11>\n`;
      xml += '  </parameters>\n';
    }
    
    // OS Requirements
    if (scriptData.os_requirements) xml += `  <os_requirements>${escapeXml(scriptData.os_requirements)}</os_requirements>\n`;
    
    // Script contents
    if (scriptData.script_contents) {
      xml += `  <script_contents>${escapeXml(scriptData.script_contents)}</script_contents>\n`;
    }
    
    // Script contents encoded flag
    if (scriptData.script_contents_encoded !== undefined) {
      xml += `  <script_contents_encoded>${scriptData.script_contents_encoded}</script_contents_encoded>\n`;
    }
    
    xml += '</script>';
    
    return xml;
  }

  /**
   * List mobile device groups
   */
  async getMobileDeviceGroups(type: 'smart' | 'static' | 'all' = 'all'): Promise<any[]> {
    await this.ensureAuthenticated();
    
    try {
      // Try Modern API first
      logger.info(`Listing mobile device groups (${type}) using Modern API...`);
      const response = await this.axiosInstance.get('/api/v1/mobile-device-groups', {
        params: {
          'page-size': 1000,
        },
      });
      
      let groups = response.data.results || [];
      
      // Filter by type if requested
      if (type !== 'all') {
        groups = groups.filter((g: any) => g.isSmart === (type === 'smart'));
      }
      
      return groups;
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
      
      // Fall back to Classic API
      try {
        const response = await this.axiosInstance.get('/JSSResource/mobiledevicegroups');
        let groups = response.data.mobile_device_groups || [];
        
        // Classic API doesn't provide group type in list, so we need to fetch each one
        if (type !== 'all') {
          const detailedGroups = [];
          for (const group of groups) {
            try {
              const details = await this.getMobileDeviceGroupDetails(group.id);
              if ((type === 'smart' && details.is_smart) || 
                  (type === 'static' && !details.is_smart)) {
                detailedGroups.push(group);
              }
            } catch (err) {
              logger.info(`Failed to get details for mobile device group ${group.id}:`, err);
            }
          }
          groups = detailedGroups;
        }
        
        return groups;
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Get mobile device group details
   */
  async getMobileDeviceGroupDetails(groupId: string): Promise<any> {
    await this.ensureAuthenticated();
    
    try {
      // Try Modern API first
      logger.info(`Getting mobile device group ${groupId} details using Modern API...`);
      const response = await this.axiosInstance.get(`/api/v1/mobile-device-groups/${groupId}`);
      return response.data;
    } catch (error) {
      logger.info('Modern API failed, trying Classic API...', {
        status: getAxiosErrorStatus(error),
        data: getAxiosErrorData(error),
      });

      if (!this.shouldFallbackToClassicOnModernError(error, { allowOn403: true })) {
        throw error;
      }
      
      // Fall back to Classic API
      try {
        const response = await this.axiosInstance.get(`/JSSResource/mobiledevicegroups/id/${groupId}`);
        const group = response.data.mobile_device_group;
        
        // Transform Classic API response
        return {
          id: group.id,
          name: group.name,
          is_smart: group.is_smart,
          criteria: group.criteria,
          mobile_devices: group.mobile_devices || [],
          site: group.site,
          memberCount: group.mobile_devices?.length || 0,
        };
      } catch (classicError) {
        logger.info('Classic API also failed:', classicError);
        throw classicError;
      }
    }
  }

  /**
   * Get inventory summary report
   * Returns total computers/mobile devices, OS version distribution, and model distribution
   */
  async getInventorySummary(): Promise<any> {
    try {
      logger.info('Generating inventory summary report...');
      
      // Fetch computers and mobile devices
      const [computers, mobileDevices] = await Promise.all([
        this.searchComputers('', 10000).catch(() => []),
        this.searchMobileDevices('', 10000).catch(() => [])
      ]);
      
      // OS Version distribution for computers
      const computerOSVersions = new Map<string, number>();
      const computerModels = new Map<string, number>();
      
      // Process computers
      for (const computer of computers) {
        // OS Version
        if (computer.osVersion) {
          const osVersion = computer.osVersion.trim();
          computerOSVersions.set(osVersion, (computerOSVersions.get(osVersion) || 0) + 1);
        }
        
        // Model - need to fetch details for model info
        if (computer.modelIdentifier) {
          const model = computer.modelIdentifier.trim();
          computerModels.set(model, (computerModels.get(model) || 0) + 1);
        }
      }
      
      // OS Version distribution for mobile devices
      const mobileOSVersions = new Map<string, number>();
      const mobileModels = new Map<string, number>();
      
      // Process mobile devices - may need to fetch details for full info
      for (const device of mobileDevices) {
        if (device.osVersion || device.os_version) {
          const osVersion = (device.osVersion || device.os_version).trim();
          mobileOSVersions.set(osVersion, (mobileOSVersions.get(osVersion) || 0) + 1);
        }
        
        if (device.model || device.model_display) {
          const model = (device.model || device.model_display || 'Unknown').trim();
          mobileModels.set(model, (mobileModels.get(model) || 0) + 1);
        }
      }
      
      // Convert maps to sorted arrays
      const sortByCount = (a: [string, number], b: [string, number]) => b[1] - a[1];
      
      return {
        summary: {
          totalComputers: computers.length,
          totalMobileDevices: mobileDevices.length,
          totalDevices: computers.length + mobileDevices.length,
        },
        computers: {
          total: computers.length,
          osVersionDistribution: Array.from(computerOSVersions.entries())
            .sort(sortByCount)
            .map(([version, count]) => ({ version, count, percentage: ((count / computers.length) * 100).toFixed(1) })),
          modelDistribution: Array.from(computerModels.entries())
            .sort(sortByCount)
            .slice(0, 20) // Top 20 models
            .map(([model, count]) => ({ model, count, percentage: ((count / computers.length) * 100).toFixed(1) })),
        },
        mobileDevices: {
          total: mobileDevices.length,
          osVersionDistribution: Array.from(mobileOSVersions.entries())
            .sort(sortByCount)
            .map(([version, count]) => ({ version, count, percentage: ((count / mobileDevices.length) * 100).toFixed(1) })),
          modelDistribution: Array.from(mobileModels.entries())
            .sort(sortByCount)
            .slice(0, 20) // Top 20 models
            .map(([model, count]) => ({ model, count, percentage: ((count / mobileDevices.length) * 100).toFixed(1) })),
        },
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.info('Failed to generate inventory summary:', error);
      throw error;
    }
  }

  /**
   * Get policy compliance report
   * Returns success/failure rates, computers in scope vs completed, and last execution times
   */
  async getPolicyComplianceReport(policyId: string): Promise<any> {
    try {
      logger.info(`Generating policy compliance report for policy ${policyId}...`);
      
      // Get policy details
      const policy = await this.getPolicyDetails(policyId);
      
      // Extract scope information
      const scopedComputers = policy.scope?.computers || [];
      const scopedGroups = policy.scope?.computer_groups || [];
      const allComputersScoped = policy.scope?.all_computers || false;
      
      // Get total computers in scope
      let totalInScope = scopedComputers.length;
      
      // Add computers from groups
      for (const group of scopedGroups) {
        try {
          const groupDetails = await this.getComputerGroupDetails(group.id.toString());
          totalInScope += groupDetails.computers?.length || 0;
        } catch (err) {
          logger.info(`Failed to get group details for ${group.id}:`, err);
        }
      }
      
      // If all computers are scoped, get total count
      if (allComputersScoped) {
        const allComputers = await this.searchComputers('', 10000);
        totalInScope = allComputers.length;
      }
      
      // Get policy logs if available (this would require access to policy logs endpoint)
      // For now, we'll extract what we can from the policy details
      const policyStatus = {
        id: policy.id,
        name: policy.general?.name,
        enabled: policy.general?.enabled,
        category: policy.general?.category?.name || policy.category,
        frequency: policy.general?.frequency,
        trigger: policy.general?.trigger,
        ongoing: policy.general?.frequency === 'Ongoing',
        lastModified: policy.general?.date_time_limitations?.activation_date,
      };
      
      // Package information
      const packages = policy.package_configuration?.packages || [];
      const scripts = policy.scripts || [];
      
      // Self Service information
      const selfServiceCategories =
        policy.self_service?.self_service_category ??
        policy.self_service?.self_service_categories?.category ??
        policy.self_service?.self_service_categories ??
        null;

      const firstSelfServiceCategory =
        Array.isArray(selfServiceCategories) ? selfServiceCategories[0] : selfServiceCategories;

      const selfService = {
        enabled: policy.self_service?.use_for_self_service || false,
        displayName: policy.self_service?.self_service_display_name,
        category: firstSelfServiceCategory?.name ?? (typeof firstSelfServiceCategory === 'string' ? firstSelfServiceCategory : undefined),
      };
      
      // Build compliance report
      return {
        policy: policyStatus,
        scope: {
          allComputers: allComputersScoped,
          totalInScope,
          directComputers: scopedComputers.length,
          computerGroups: scopedGroups.map((g: any) => ({
            id: g.id,
            name: g.name,
          })),
          limitations: {
            buildings: policy.scope?.buildings?.length || 0,
            departments: policy.scope?.departments?.length || 0,
            networkSegments: policy.scope?.network_segments?.length || 0,
          },
          exclusions: {
            computers: policy.scope?.exclusions?.computers?.length || 0,
            computerGroups: policy.scope?.exclusions?.computer_groups?.length || 0,
            buildings: policy.scope?.exclusions?.buildings?.length || 0,
            departments: policy.scope?.exclusions?.departments?.length || 0,
          },
        },
        payloads: {
          packages: packages.map((pkg: any) => ({
            id: pkg.id,
            name: pkg.name,
            action: pkg.action,
          })),
          scripts: scripts.map((script: any) => ({
            id: script.id,
            name: script.name,
            priority: script.priority,
          })),
          totalPayloads: packages.length + scripts.length,
        },
        selfService,
        compliance: {
          note: 'Detailed execution logs would require access to policy logs endpoint',
          estimatedCompliance: {
            inScope: totalInScope,
            message: 'Use Jamf Pro web interface for detailed execution history',
          },
        },
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.info('Failed to generate policy compliance report:', error);
      throw error;
    }
  }

  /**
   * Get package deployment statistics
   * Returns policies using the package, deployment success rate, and target device count
   */
  async getPackageDeploymentStats(packageId: string): Promise<any> {
    try {
      logger.info(`Generating package deployment statistics for package ${packageId}...`);
      
      // Get package details
      const packageDetails = await this.getPackageDetails(packageId);
      
      // Get policies using this package
      const policiesUsingPackage = await this.getPoliciesUsingPackage(packageId);
      
      // Calculate total target devices
      let totalTargetDevices = 0;
      const policyStats = [];
      
      for (const policy of policiesUsingPackage) {
        let scopeSize = 0;
        
        // Try to get more detailed policy info to calculate scope
        try {
          const fullPolicy = await this.getPolicyDetails(policy.id.toString());
          
          // Calculate scope size
          if (fullPolicy.scope?.all_computers) {
            const allComputers = await this.searchComputers('', 10000);
            scopeSize = allComputers.length;
          } else {
            scopeSize = fullPolicy.scope?.computers?.length || 0;
            
            // Add computers from groups
            for (const group of (fullPolicy.scope?.computer_groups || [])) {
              try {
                const groupDetails = await this.getComputerGroupDetails(group.id.toString());
                scopeSize += groupDetails.computers?.length || 0;
              } catch (err) {
                logger.info(`Failed to get group details for ${group.id}:`, err);
              }
            }
          }
          
          // Subtract exclusions
          scopeSize -= fullPolicy.scope?.exclusions?.computers?.length || 0;
        } catch (err) {
          logger.info(`Failed to get detailed scope for policy ${policy.id}:`, err);
          scopeSize = policy.targetedComputers || 0;
        }
        
        totalTargetDevices += scopeSize;
        
        policyStats.push({
          policyId: policy.id,
          policyName: policy.name,
          enabled: policy.enabled,
          frequency: policy.frequency,
          category: policy.category,
          packageAction: policy.packageAction,
          scopeSize,
          targetedComputerGroups: policy.targetedComputerGroups,
        });
      }
      
      return {
        package: {
          id: packageDetails.id,
          name: packageDetails.name || packageDetails.filename,
          category: packageDetails.category,
          filename: packageDetails.filename,
          size: packageDetails.size,
          priority: packageDetails.priority || 10,
          fillUserTemplate: packageDetails.fill_user_template,
          rebootRequired: packageDetails.reboot_required,
          installIfReportedAvailable: packageDetails.install_if_reported_available,
          notes: packageDetails.notes,
        },
        deployment: {
          totalPoliciesUsing: policiesUsingPackage.length,
          totalTargetDevices,
          policies: policyStats,
        },
        usage: {
          note: 'Deployment success rates would require access to policy logs',
          activePolicies: policyStats.filter(p => p.enabled).length,
          inactivePolicies: policyStats.filter(p => !p.enabled).length,
          byFrequency: policyStats.reduce((acc, p) => {
            const freq = p.frequency || 'Unknown';
            acc[freq] = (acc[freq] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          byCategory: policyStats.reduce((acc, p) => {
            const cat = p.category || 'Uncategorized';
            acc[cat] = (acc[cat] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        },
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.info('Failed to generate package deployment statistics:', error);
      throw error;
    }
  }

  /**
   * List patch titles available from a specific patch source (Classic API).
   * Source 1 is typically Jamf's built-in patch catalog.
   */
  private extractPatchAvailableTitleRows(payload: any): any[] {
    const toArray = (value: any): any[] =>
      Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];

    const candidates = [
      payload?.patch_available_titles?.available_titles?.available_title,
      payload?.patch_available_titles?.patch_available_title,
      payload?.available_titles?.available_title,
      payload?.patch_available_title,
      payload?.available_title,
      payload?.results,
      payload,
    ];

    for (const candidate of candidates) {
      const rows = toArray(candidate);
      if (rows.length > 0) return rows;
    }
    return [];
  }

  private decodeXmlEntities(value: string): string {
    return value
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  private parsePatchAvailableTitlesXml(xml: string): { size: string | null; rows: any[] } {
    if (!xml) return { size: null, rows: [] };

    const sizeMatch = xml.match(/<size>([^<]+)<\/size>/i);
    const reportedSize = sizeMatch?.[1]?.trim() ?? null;

    const rows: any[] = [];
    const entryRegex = /<available_title>([\s\S]*?)<\/available_title>/gi;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRegex.exec(xml)) !== null) {
      const block = entryMatch[1];
      const getTag = (tag: string): string => {
        const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
        return m ? this.decodeXmlEntities(m[1].trim()) : '';
      };

      rows.push({
        name_id: getTag('name_id'),
        app_name: getTag('app_name'),
        publisher: getTag('publisher'),
        current_version: getTag('current_version'),
        last_modified: getTag('last_modified'),
      });
    }

    return { size: reportedSize, rows };
  }

  private extractPatchSoftwareTitleConfigurationRows(payload: any): any[] {
    const toArray = (value: any): any[] =>
      Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];

    const candidates = [payload?.results, payload?.items, payload?.configurations, payload];

    for (const candidate of candidates) {
      const rows = toArray(candidate);
      if (rows.length > 0) return rows;
    }
    return [];
  }

  private flattenErrorText(value: unknown, out: string[]): void {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.flattenErrorText(item, out);
      return;
    }
    if (typeof value === 'object') {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        this.flattenErrorText(entry, out);
      }
    }
  }

  private getPatchCreateErrorText(error: unknown): string {
    const parts: string[] = [];
    this.flattenErrorText(getErrorMessage(error), parts);
    this.flattenErrorText(getAxiosErrorData(error), parts);
    return parts.join(' | ').toLowerCase();
  }

  private isPatchCreateMissingSoftwareTitleIdError(error: unknown): boolean {
    if (getAxiosErrorStatus(error) !== 400) return false;
    const text = this.getPatchCreateErrorText(error);
    return (
      text.includes("software title id doesn't exist") ||
      text.includes('id field must be string of positive numeric value')
    );
  }

  private isPatchCreateAlreadyExistsError(error: unknown): boolean {
    if (getAxiosErrorStatus(error) !== 400 && getAxiosErrorStatus(error) !== 409) return false;
    const text = this.getPatchCreateErrorText(error);
    return text.includes('already exists');
  }

  private parseXmlTagValue(xmlPayload: unknown, tag: string): string | null {
    const xml = String(xmlPayload ?? '');
    if (!xml) return null;
    const escapedTag = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = xml.match(new RegExp(`<${escapedTag}>\\s*([^<]+?)\\s*<\\/${escapedTag}>`, 'i'));
    return match?.[1]?.trim() ?? null;
  }

  private buildPatchSoftwareTitleCreateXml(input: {
    nameId: string;
    displayName?: string;
    sourceId?: string;
  }): string {
    const nameId = this.escapeXmlValue(String(input.nameId ?? '').trim());
    const sourceId = this.escapeXmlValue(String(input.sourceId ?? '1').trim() || '1');
    const displayName = String(input.displayName ?? '').trim();

    return `<patch_software_title><name_id>${nameId}</name_id><source_id>${sourceId}</source_id>${
      displayName ? `<name>${this.escapeXmlValue(displayName)}</name>` : ''
    }</patch_software_title>`;
  }

  private async resolveClassicPatchSoftwareTitleIdByNameId(nameId: string): Promise<string | null> {
    const response = await this.axiosInstance.get('/JSSResource/patchsoftwaretitles', {
      headers: { Accept: 'application/json' },
    });
    const rows = Array.isArray(response.data?.patch_software_titles) ? response.data.patch_software_titles : [];
    const found = rows.find((row: any) => String(row?.name_id ?? '') === String(nameId));
    const resolvedId = found?.id;
    if (resolvedId === null || resolvedId === undefined) return null;
    const normalized = String(resolvedId).trim();
    if (!normalized || normalized === '-1') return null;
    return normalized;
  }

  private async ensureClassicPatchSoftwareTitleOnboarded(
    nameId: string,
    displayName?: string,
    sourceId: string = '1'
  ): Promise<string> {
    const normalizedNameId = String(nameId ?? '').trim();
    if (!normalizedNameId) {
      throw new Error('Missing patch software title name_id for Classic onboarding');
    }

    const existingId = await this.resolveClassicPatchSoftwareTitleIdByNameId(normalizedNameId);
    if (existingId) return existingId;

    const xmlPayload = this.buildPatchSoftwareTitleCreateXml({
      nameId: normalizedNameId,
      displayName,
      sourceId,
    });

    try {
      const response = await this.axiosInstance.post('/JSSResource/patchsoftwaretitles/id/0', xmlPayload, {
        headers: {
          'Content-Type': 'application/xml',
          Accept: 'application/xml',
        },
      });
      const createdId = this.parseXmlTagValue(response.data, 'id');
      if (createdId) return createdId;
    } catch (error) {
      if (!this.isPatchCreateAlreadyExistsError(error)) {
        throw error;
      }
    }

    const resolvedId = await this.resolveClassicPatchSoftwareTitleIdByNameId(normalizedNameId);
    if (resolvedId) return resolvedId;

    throw new Error(
      `Classic patch software title onboarding for name_id "${normalizedNameId}" did not yield a numeric softwareTitleId`
    );
  }

  private async findPatchSoftwareTitleConfigurationBySoftwareTitleId(
    softwareTitleId: string,
    limit: number = 200
  ): Promise<any | null> {
    const response = await this.axiosInstance.get('/api/v2/patch-software-title-configurations', {
      params: { 'page-size': limit },
    });
    const rows = this.extractPatchSoftwareTitleConfigurationRows(response.data);
    return (
      rows.find((row: any) => String(row?.softwareTitleId ?? '').trim() === String(softwareTitleId).trim()) ?? null
    );
  }

  async listPatchAvailableTitles(sourceId: string = '1'): Promise<any> {
    await this.ensureAuthenticated();

    const endpoint = `/JSSResource/patchavailabletitles/sourceid/${encodeURIComponent(sourceId)}`;

    const jsonResponse = await this.axiosInstance.get(endpoint, {
      headers: { Accept: 'application/json' },
    });
    const jsonPayload = jsonResponse.data;

    const jsonRows = this.extractPatchAvailableTitleRows(jsonPayload);
    const reportedSize = Number(jsonPayload?.patch_available_titles?.size ?? 0);

    // Some Jamf tenants return only one row in JSON even when size reports many titles.
    // In that case, fall back to XML and parse all entries.
    if (reportedSize > 0 && jsonRows.length <= 1) {
      try {
        const xmlResponse = await this.axiosInstance.get(endpoint, {
          headers: { Accept: 'application/xml' },
          responseType: 'text' as any,
          transformResponse: (d: any) => d,
        });
        const xmlPayload = String((xmlResponse as any).data ?? '');
        const parsed = this.parsePatchAvailableTitlesXml(xmlPayload);

        if (parsed.rows.length > jsonRows.length) {
          return {
            patch_available_titles: {
              size: parsed.size ?? String(reportedSize || parsed.rows.length),
              available_titles: {
                available_title: parsed.rows,
              },
            },
          };
        }
      } catch (error) {
        logger.warn('Patch available titles XML fallback failed; returning JSON payload', {
          status: getAxiosErrorStatus(error),
          data: getAxiosErrorData(error),
        });
      }
    }

    return jsonPayload;
  }

  /**
   * List patch policies (Jamf Pro Patch Management, Modern API).
   */
  async listPatchPolicies(limit: number = 100): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get('/api/v2/patch-policies', {
      params: { 'page-size': limit },
    });
    return response.data;
  }

  /**
   * Get patch policy logs by policy ID (Jamf Pro Patch Management, Modern API).
   */
  async getPatchPolicyLogs(policyId: string, limit: number = 100): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get(`/api/v2/patch-policies/${policyId}/logs`, {
      params: { 'page-size': limit },
    });
    return response.data;
  }

  /**
   * Retry patch policy logs.
   * - retryAll=true uses /retry-all
   * - otherwise uses /retry with optional payload
   */
  async retryPatchPolicyLogs(policyId: string, retryAll: boolean = false, payload?: any): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot retry patch policy logs in read-only mode');
    }

    await this.ensureAuthenticated();

    if (retryAll) {
      const response = await this.axiosInstance.post(`/api/v2/patch-policies/${policyId}/logs/retry-all`);
      return response.data;
    }

    const response =
      payload === undefined
        ? await this.axiosInstance.post(`/api/v2/patch-policies/${policyId}/logs/retry`)
        : await this.axiosInstance.post(`/api/v2/patch-policies/${policyId}/logs/retry`, payload);
    return response.data;
  }

  /**
   * List patch software title configurations.
   */
  async listPatchSoftwareTitleConfigurations(limit: number = 100): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get('/api/v2/patch-software-title-configurations', {
      params: { 'page-size': limit },
    });
    return response.data;
  }

  /**
   * Get patch software title configuration by ID.
   */
  async getPatchSoftwareTitleConfiguration(configId: string): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get(`/api/v2/patch-software-title-configurations/${configId}`);
    return response.data;
  }

  /**
   * Get patch report for a patch software title configuration.
   */
  async getPatchSoftwareTitleConfigurationReport(configId: string): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get(`/api/v2/patch-software-title-configurations/${configId}/patch-report`);
    return response.data;
  }

  /**
   * Get patch summary (aggregated) for a patch software title configuration.
   */
  async getPatchSoftwareTitleConfigurationSummary(configId: string): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get(`/api/v2/patch-software-title-configurations/${configId}/patch-summary`);
    return response.data;
  }

  /**
   * Get patch summary by versions for a patch software title configuration.
   */
  async getPatchSoftwareTitleConfigurationVersionSummary(configId: string): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get(
      `/api/v2/patch-software-title-configurations/${configId}/patch-summary/versions`
    );
    return response.data;
  }

  /**
   * Create patch software title configuration.
   */
  async createPatchSoftwareTitleConfiguration(config: any): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create patch software title configurations in read-only mode');
    }

    await this.ensureAuthenticated();
    const createViaV2 = async (payload: any): Promise<any> => {
      const response = await this.axiosInstance.post('/api/v2/patch-software-title-configurations', payload);
      const configId = this.extractPatchSoftwareTitleConfigurationId(response.data);
      const strictEnabled = String(process.env.JAMF_PATCH_VERIFY_ENABLED ?? 'true').toLowerCase() !== 'false';
      if (strictEnabled && !configId) {
        throw new Error(
          'Patch software title configuration create did not return an id; cannot verify persistence in strict mode'
        );
      }
      if (!configId) return response.data;
      return await this.verifyPatchSoftwareTitleConfigurationPersisted(
        configId,
        payload,
        response.data,
        { topLevelOnly: true }
      );
    };

    try {
      return await createViaV2(config);
    } catch (error) {
      if (!this.isPatchCreateMissingSoftwareTitleIdError(error)) {
        throw error;
      }

      const requestedSoftwareTitleId = String(config?.softwareTitleId ?? '').trim();
      if (!requestedSoftwareTitleId || requestedSoftwareTitleId === '-1') {
        throw error;
      }

      const sourceId = String(config?.sourceId ?? '1').trim() || '1';
      const onboardedSoftwareTitleId = await this.ensureClassicPatchSoftwareTitleOnboarded(
        requestedSoftwareTitleId,
        String(config?.displayName ?? '').trim() || undefined,
        sourceId
      );

      const retryPayload = { ...config, softwareTitleId: onboardedSoftwareTitleId };
      try {
        return await createViaV2(retryPayload);
      } catch (retryError) {
        if (!this.isPatchCreateAlreadyExistsError(retryError)) {
          throw retryError;
        }

        const existing = await this.findPatchSoftwareTitleConfigurationBySoftwareTitleId(onboardedSoftwareTitleId);
        if (!existing) {
          throw retryError;
        }
        return existing;
      }
    }
  }

  /**
   * Update patch software title configuration.
   */
  async updatePatchSoftwareTitleConfiguration(configId: string, updates: any): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot update patch software title configurations in read-only mode');
    }

    await this.ensureAuthenticated();

    const response = await this.axiosInstance.patch(
      `/api/v2/patch-software-title-configurations/${configId}`,
      updates,
      {
        headers: {
          'Content-Type': 'application/merge-patch+json',
        },
      }
    );
    return await this.verifyPatchSoftwareTitleConfigurationPersisted(configId, updates, response.data);
  }

  /**
   * Delete patch software title configuration.
   */
  async deletePatchSoftwareTitleConfiguration(configId: string): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot delete patch software title configurations in read-only mode');
    }

    await this.ensureAuthenticated();

    const response = await this.axiosInstance.delete(`/api/v2/patch-software-title-configurations/${configId}`);
    await this.verifyPatchSoftwareTitleConfigurationDeleted(configId);
    return response.data;
  }

  /**
   * Retrieve available managed software updates.
   */
  async getManagedSoftwareUpdatesAvailable(): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get('/api/v1/managed-software-updates/available-updates');
    return response.data;
  }

  /**
   * Retrieve Managed Software Update plans feature-toggle details.
   */
  async getManagedSoftwareUpdatePlansFeatureToggle(): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get('/api/v1/managed-software-updates/plans/feature-toggle');
    return response.data;
  }

  /**
   * Retrieve Managed Software Update plans feature-toggle status.
   */
  async getManagedSoftwareUpdatePlansFeatureToggleStatus(): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get('/api/v1/managed-software-updates/plans/feature-toggle/status');
    return response.data;
  }

  /**
   * Retrieve managed software update statuses.
   */
  async getManagedSoftwareUpdateStatuses(limit: number = 100): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get('/api/v1/managed-software-updates/update-statuses', {
      params: { 'page-size': limit },
    });
    return response.data;
  }

  /**
   * List managed software update plans.
   */
  async listManagedSoftwareUpdatePlans(limit: number = 100): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get('/api/v1/managed-software-updates/plans', {
      params: { 'page-size': limit },
    });
    return response.data;
  }

  /**
   * Get a managed software update plan by ID.
   */
  async getManagedSoftwareUpdatePlan(planId: string): Promise<any> {
    await this.ensureAuthenticated();

    const response = await this.axiosInstance.get(`/api/v1/managed-software-updates/plans/${planId}`);
    return response.data;
  }

  /**
   * Create a managed software update plan.
   */
  async createManagedSoftwareUpdatePlan(plan: any): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create managed software update plans in read-only mode');
    }

    await this.ensureAuthenticated();

    const response = await this.axiosInstance.post('/api/v1/managed-software-updates/plans', plan);
    return response.data;
  }

  /**
   * Create managed software update plans for a group.
   */
  async createManagedSoftwareUpdatePlanForGroup(plan: any): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create managed software update plans for a group in read-only mode');
    }

    await this.ensureAuthenticated();

    const response = await this.axiosInstance.post('/api/v1/managed-software-updates/plans/group', plan);
    return response.data;
  }

  /**
   * Get software version report
   * Returns version distribution across devices and identifies out-of-date installations
   */
  async getSoftwareVersionReport(softwareName: string): Promise<any> {
    try {
      logger.info(`Generating software version report for "${softwareName}"...`);
      
      // Search for computers that might have this software
      // Note: This is a basic implementation - full software inventory would require
      // access to computer applications endpoint
      const computers = await this.searchComputers('', 10000);
      
      // We'll need to fetch details for a sample of computers to check software
      const sampleSize = Math.min(100, computers.length); // Check up to 100 computers
      const sampledComputers = computers.slice(0, sampleSize);
      
      const softwareVersions = new Map<string, { count: number; computers: any[] }>();
      let computersWithSoftware = 0;
      
      // Check each computer for the software
      for (const computer of sampledComputers) {
        try {
          const details = await this.getComputerDetails(computer.id);
          
          // Check applications (different API versions have different structures)
          const applications = details.software?.applications || 
                             details.applications || 
                             details.computer?.software?.applications || 
                             [];
          
          // Find matching software
          const matchingSoftware = applications.filter((app: any) => 
            app.name?.toLowerCase().includes(softwareName.toLowerCase()) ||
            app.application_name?.toLowerCase().includes(softwareName.toLowerCase())
          );
          
          if (matchingSoftware.length > 0) {
            computersWithSoftware++;
            
            for (const app of matchingSoftware) {
              const version = app.version || app.application_version || 'Unknown';
              const appName = app.name || app.application_name;
              const key = `${appName} - ${version}`;
              
              if (!softwareVersions.has(key)) {
                softwareVersions.set(key, { count: 0, computers: [] });
              }
              
              const versionData = softwareVersions.get(key)!;
              versionData.count++;
              versionData.computers.push({
                id: computer.id,
                name: computer.name,
                serialNumber: computer.serialNumber,
              });
            }
          }
        } catch (err) {
          logger.info(`Failed to get details for computer ${computer.id}:`, err);
        }
      }
      
      // Convert to sorted array
      const versionDistribution = Array.from(softwareVersions.entries())
        .map(([key, data]) => {
          const [name, version] = key.split(' - ');
          return {
            software: name,
            version,
            count: data.count,
            percentage: ((data.count / computersWithSoftware) * 100).toFixed(1),
            computers: data.computers.slice(0, 5), // First 5 computers
          };
        })
        .sort((a, b) => b.count - a.count);
      
      // Try to identify latest version (highest version number)
      const versions = versionDistribution
        .map(v => v.version)
        .filter(v => v !== 'Unknown')
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
      
      const latestVersion = versions[0] || 'Unknown';
      
      // Identify out-of-date installations
      const outOfDateInstallations = versionDistribution
        .filter(v => v.version !== latestVersion && v.version !== 'Unknown')
        .reduce((sum, v) => sum + v.count, 0);
      
      return {
        search: {
          softwareName,
          computersChecked: sampleSize,
          totalComputers: computers.length,
          note: `Checked ${sampleSize} of ${computers.length} computers for performance reasons`,
        },
        results: {
          computersWithSoftware,
          totalInstallations: Array.from(softwareVersions.values()).reduce((sum, v) => sum + v.count, 0),
          uniqueVersions: versionDistribution.length,
          latestVersionDetected: latestVersion,
          outOfDateInstallations,
        },
        versionDistribution,
        recommendations: {
          updateNeeded: outOfDateInstallations > 0,
          message: outOfDateInstallations > 0 
            ? `${outOfDateInstallations} computers may need software updates`
            : 'All checked computers appear to have consistent versions',
        },
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.info('Failed to generate software version report:', error);
      throw error;
    }
  }

  /**
   * Get device compliance summary
   * Returns devices checking in regularly, devices with failed policies, and devices missing critical software
   */
  async getDeviceComplianceSummary(): Promise<any> {
    try {
      logger.info('Generating device compliance summary...');
      
      let computers = [];
      
      // Try to use advanced search first (has last check-in times)
      try {
        logger.info('Attempting to use advanced search for compliance data...');
        
        // Use search ID 63 as requested
        const searchId = 63; 
        logger.info(`Using search ID: ${searchId} as requested...`);
        
        // First, let's check what fields this search has
        const searchDetails = await this.getAdvancedComputerSearchDetails(String(searchId));
        logger.info('Search display fields:', searchDetails.display_fields);
        
        // Use this search to get computers - it should return ALL computers with check-in data
        const response = await this.axiosInstance.get(`/JSSResource/advancedcomputersearches/id/${searchId}`);
        const searchResults = response.data.advanced_computer_search?.computers || [];
        
        // For compliance, we need ALL computers, not just those that haven't checked in
        // So let's use the basic list and enrich with details
        const basicComputers = await this.searchComputers('', 1000);
        
        // Create a map of check-in data from the advanced search
        const checkInMap = new Map();
        searchResults.forEach((c: any) => {
          checkInMap.set(String(c.id), c);
        });
        
        // Debug: Log the first computer to see field names
        if (searchResults.length > 0) {
          logger.info('Sample computer from search:', JSON.stringify(searchResults[0], null, 2));
        }
        
        // Enrich basic computers with check-in data
        computers = basicComputers.map((computer) => {
          const searchData = checkInMap.get(computer.id) || {};
          
          // Try to get check-in time from various possible fields
          const checkInTime = searchData.Last_Check_in || 
                           searchData['Last Check-in'] || 
                           searchData.last_contact_time ||
                           searchData.Last_Contact_Time ||
                           searchData['Last Contact Time'] ||
                           computer.lastContactTime;
          
          // If this is Dwight's computer, let's debug
          if (computer.id === '759' || computer.name === 'GH-IT-0322') {
            logger.info(`Found Dwight's computer (${computer.name}):`, {
              id: computer.id,
              searchData: searchData,
              checkInTime: checkInTime
            });
          }
          
          return {
            ...computer,
            lastContactTime: checkInTime || 'Unknown',
          };
        });
        
        logger.info(`Found ${computers.length} computers with ${checkInMap.size} having check-in data`);
      } catch (advSearchError: any) {
        logger.info('Advanced search failed:', advSearchError.message);
        logger.info('Falling back to basic search with individual lookups...');
        
        // Fall back to basic search
        const basicComputers = await this.searchComputers('', 100); // Limit to 100 to avoid timeout
        
        // For each computer, get detailed info to find last contact time
        computers = await Promise.all(
          basicComputers.slice(0, 50).map(async (computer) => { // Further limit for performance
            try {
              const details = await this.getComputerDetails(computer.id);
              return {
                ...computer,
                lastContactTime: details.general?.last_contact_time || 
                                details.general?.last_contact_time_utc ||
                                details.general?.last_check_in ||
                                details.general?.report_date ||
                                'Unknown'
              };
            } catch (err) {
              logger.info(`Failed to get details for computer ${computer.id}:`, err);
              return computer;
            }
          })
        );
        
        // Add a note about limited data
        logger.info(`Note: Due to API limitations, showing compliance for first ${computers.length} devices only`);
      }
      
      // Define compliance criteria
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      // Categorize devices by last contact time
      const devicesCheckingInToday = [];
      const devicesCheckingInThisWeek = [];
      const devicesNotSeenThisWeek = [];
      const devicesNotSeenThisMonth = [];
      
      for (const computer of computers) {
        // Try multiple possible field names for last contact time
        const computerAny = computer as any;
        const lastContactStr = computerAny.lastContactTime || 
                              computerAny.last_contact_time || 
                              computerAny.lastReportDate || 
                              computerAny.last_report_date ||
                              computerAny.lastCheckIn ||
                              computerAny.last_check_in ||
                              computerAny.last_checkin_time ||
                              computerAny.lastCheckinTime;
        
        const lastContact = lastContactStr ? new Date(lastContactStr) : null;
        
        if (!lastContact || isNaN(lastContact.getTime())) {
          devicesNotSeenThisMonth.push(computer);
        } else if (lastContact >= oneDayAgo) {
          devicesCheckingInToday.push(computer);
        } else if (lastContact >= sevenDaysAgo) {
          devicesCheckingInThisWeek.push(computer);
        } else if (lastContact >= thirtyDaysAgo) {
          devicesNotSeenThisWeek.push(computer);
        } else {
          devicesNotSeenThisMonth.push(computer);
        }
      }
      
      // Get policy compliance (sample check - would need policy logs for full data)
      const policies = await this.listPolicies(100);
      const failedPolicies = [];
      
      // Check a few critical policies
      const criticalPolicyNames = ['Software Update', 'Security Update', 'Inventory Update'];
      for (const policy of policies) {
        if (criticalPolicyNames.some(name => policy.name?.toLowerCase().includes(name.toLowerCase()))) {
          try {
            const details = await this.getPolicyDetails(policy.id.toString());
            if (details.general?.enabled) {
              failedPolicies.push({
                id: policy.id,
                name: policy.name,
                category: details.general?.category?.name || 'Uncategorized',
                frequency: details.general?.frequency,
              });
            }
          } catch (err) {
            logger.info(`Failed to get policy details for ${policy.id}:`, err);
          }
        }
      }
      
      // Build compliance summary
      return {
        summary: {
          totalDevices: computers.length,
          compliantDevices: devicesCheckingInToday.length + devicesCheckingInThisWeek.length,
          nonCompliantDevices: devicesNotSeenThisWeek.length + devicesNotSeenThisMonth.length,
          complianceRate: (((devicesCheckingInToday.length + devicesCheckingInThisWeek.length) / computers.length) * 100).toFixed(1),
        },
        checkInStatus: {
          today: {
            count: devicesCheckingInToday.length,
            percentage: ((devicesCheckingInToday.length / computers.length) * 100).toFixed(1),
            devices: devicesCheckingInToday.slice(0, 10).map(d => ({
              id: d.id,
              name: d.name,
              lastContact: d.lastContactTime,
            })),
          },
          thisWeek: {
            count: devicesCheckingInThisWeek.length,
            percentage: ((devicesCheckingInThisWeek.length / computers.length) * 100).toFixed(1),
            devices: devicesCheckingInThisWeek.slice(0, 10).map(d => ({
              id: d.id,
              name: d.name,
              lastContact: d.lastContactTime,
            })),
          },
          notSeenThisWeek: {
            count: devicesNotSeenThisWeek.length,
            percentage: ((devicesNotSeenThisWeek.length / computers.length) * 100).toFixed(1),
            devices: devicesNotSeenThisWeek.slice(0, 10).map(d => ({
              id: d.id,
              name: d.name,
              lastContact: d.lastContactTime,
            })),
          },
          notSeenThisMonth: {
            count: devicesNotSeenThisMonth.length,
            percentage: ((devicesNotSeenThisMonth.length / computers.length) * 100).toFixed(1),
            devices: devicesNotSeenThisMonth.slice(0, 10).map(d => ({
              id: d.id,
              name: d.name,
              lastContact: d.lastContactTime,
            })),
          },
        },
        criticalPolicies: {
          monitored: failedPolicies.length,
          policies: failedPolicies,
          note: 'Full policy execution status would require access to policy logs',
        },
        recommendations: {
          immediate: devicesNotSeenThisMonth.length > 0 
            ? `${devicesNotSeenThisMonth.length} devices haven't checked in for over 30 days and may need attention`
            : null,
          warning: devicesNotSeenThisWeek.length > 0
            ? `${devicesNotSeenThisWeek.length} devices haven't checked in this week`
            : null,
        },
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.info('Failed to generate device compliance summary:', error);
      throw error;
    }
  }

  /**
   * Create an advanced computer search via Classic API
   */
  async createAdvancedComputerSearch(searchData: {
    name: string;
    criteria?: Array<{
      name: string;
      priority: number;
      and_or: 'and' | 'or';
      search_type: string;
      value: string;
    }>;
    display_fields?: string[];
  }): Promise<any> {
    if (this._readOnlyMode) {
      throw new Error('Cannot create advanced computer searches in read-only mode');
    }

    await this.ensureAuthenticated();

    // Default display fields to include comprehensive device information
    const defaultDisplayFields = [
      'Computer Name',
      'Last Check-in',
      'Last Inventory Update',
      'IP Address',
      'Serial Number',
      'Operating System Version',
      'Username',
      'Real Name',
      'Email Address',
      'Department',
      'Building',
      'Model',
      'Model Identifier',
      'Architecture Type',
      'Make',
      'Total RAM MB',
      'Managed',
      'Supervised',
      'MDM Capable'
    ];

    const displayFields = searchData.display_fields || defaultDisplayFields;

    // Build XML payload for the Classic API
    const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<advanced_computer_search>
  <name>${this.escapeXml(searchData.name)}</name>
  <view_as>Standard Web Page</view_as>
  <sort_1></sort_1>
  <sort_2></sort_2>
  <sort_3></sort_3>
  <criteria>
    ${searchData.criteria ? searchData.criteria.map(criterion => `
    <criterion>
      <name>${this.escapeXml(criterion.name)}</name>
      <priority>${criterion.priority}</priority>
      <and_or>${criterion.and_or}</and_or>
      <search_type>${this.escapeXml(criterion.search_type)}</search_type>
      <value>${this.escapeXml(criterion.value)}</value>
    </criterion>`).join('') : ''}
  </criteria>
  <display_fields>
    ${displayFields.map(field => `
    <display_field>
      <name>${this.escapeXml(field)}</name>
    </display_field>`).join('')}
  </display_fields>
</advanced_computer_search>`;

    try {
      logger.info(`Creating advanced computer search "${searchData.name}" via Classic API...`);
      
      const response = await this.axiosInstance.post(
        '/JSSResource/advancedcomputersearches/id/0',
        xmlPayload,
        {
          headers: {
            'Content-Type': 'application/xml',
            'Accept': 'application/xml',
          }
        }
      );

      // Extract the created search ID from the response
      // The Classic API typically returns the ID in the Location header or response body
      const locationHeader = response.headers.location;
      let searchId: string | null = null;

      if (locationHeader) {
        const match = locationHeader.match(/\/id\/(\d+)$/);
        if (match) {
          searchId = match[1];
        }
      }

      // If no ID in header, try to parse from response
      if (!searchId && response.data) {
        // Classic API might return XML response with the ID
        const idMatch = String(response.data).match(/<id>(\d+)<\/id>/);
        if (idMatch) {
          searchId = idMatch[1];
        }
      }

      if (searchId) {
        logger.info(`Successfully created advanced computer search with ID: ${searchId}`);
        // Fetch and return the full search details
        return await this.getAdvancedComputerSearchDetails(searchId);
      } else {
        // Return basic info if we couldn't get the ID
        return {
          name: searchData.name,
          message: 'Advanced computer search created successfully',
        };
      }
    } catch (error) {
      logger.info('Failed to create advanced computer search:', error);
      throw new Error(`Failed to create advanced computer search: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Get advanced computer search details
   */
  async getAdvancedComputerSearchDetails(searchId: string): Promise<any> {
    await this.ensureAuthenticated();

    try {
      const response = await this.axiosInstance.get(
        `/JSSResource/advancedcomputersearches/id/${searchId}`,
        {
          headers: {
            'Accept': 'application/json',
          }
        }
      );

      return response.data.advanced_computer_search || response.data;
    } catch (error) {
      logger.info(`Failed to get advanced computer search ${searchId}:`, error);
      throw new Error(`Failed to get advanced computer search details: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Delete an advanced computer search
   */
  async deleteAdvancedComputerSearch(searchId: string): Promise<void> {
    if (this._readOnlyMode) {
      throw new Error('Cannot delete advanced computer searches in read-only mode');
    }
    
    await this.ensureAuthenticated();
    
    try {
      await this.axiosInstance.delete(`/JSSResource/advancedcomputersearches/id/${searchId}`);
      logger.info(`Successfully deleted advanced computer search ${searchId}`);
    } catch (error) {
      logger.info(`Failed to delete advanced computer search ${searchId}:`, error);
      throw new Error(`Failed to delete advanced computer search: ${getErrorMessage(error)}`);
    }
  }

  /**
   * List all advanced computer searches
   */
  async listAdvancedComputerSearches(): Promise<any[]> {
    await this.ensureAuthenticated();

    try {
      const response = await this.axiosInstance.get(
        '/JSSResource/advancedcomputersearches',
        {
          headers: {
            'Accept': 'application/json',
          }
        }
      );

      return response.data.advanced_computer_searches || [];
    } catch (error) {
      logger.info('Failed to list advanced computer searches:', error);
      throw new Error(`Failed to list advanced computer searches: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Ensure a compliance-specific advanced search exists
   * Creates one if it doesn't exist, returns the search ID
   */
  async ensureComplianceSearch(): Promise<string> {
    const COMPLIANCE_SEARCH_NAME = 'Device Compliance Check - MCP Generated';

    try {
      // First, check if the search already exists
      const searches = await this.listAdvancedComputerSearches();
      const existingSearch = searches.find(
        (search: any) => search.name === COMPLIANCE_SEARCH_NAME
      );

      if (existingSearch) {
        logger.info(`Found existing compliance search with ID: ${existingSearch.id}`);
        return existingSearch.id.toString();
      }

      // Create a new compliance search
      logger.info('Creating new compliance search...');
      
      const searchData = {
        name: COMPLIANCE_SEARCH_NAME,
        criteria: [
          {
            name: 'Last Check-in',
            priority: 0,
            and_or: 'and' as const,
            search_type: 'more than x days ago',
            value: '0', // This will return all computers
          }
        ],
        display_fields: [
          'Computer Name',
          'Last Check-in',
          'Last Inventory Update', 
          'IP Address',
          'Serial Number',
          'Operating System Version',
          'Username',
          'Real Name',
          'Email Address',
          'Department',
          'Building',
          'Model',
          'Managed',
          'Supervised',
          'MDM Capable',
          'Architecture Type',
          'Total RAM MB',
          'Available RAM Slots',
          'Battery Capacity',
          'Boot Drive Available MB',
          'Number of Processors',
          'Processor Speed MHz',
          'Processor Type'
        ]
      };

      const result = await this.createAdvancedComputerSearch(searchData);
      
      // Extract ID from result
      const searchId = result.id || result.search_id;
      if (!searchId) {
        throw new Error('Failed to get ID of created compliance search');
      }

      logger.info(`Successfully created compliance search with ID: ${searchId}`);
      return searchId.toString();
    } catch (error) {
      logger.info('Failed to ensure compliance search exists:', error);
      throw new Error(`Failed to ensure compliance search: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Helper method to escape XML special characters
   */
  private escapeXml(unsafe: string): string {
    return unsafe
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
