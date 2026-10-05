/**
 * Placeholder for the call made after `/api/oauth/authorizations` succeeds.
 * Replace the body with the real downstream API call.
 */
export interface PostAuthorizationInput {
  service: string;
  connectionName?: string;
  userId?: string;
  companyId?: string;
  /** Response of `/api/oauth/authorizations`. */
  authorization: { authorizationUrl: string; state: string };
}

export async function callPostAuthorizationApi(_input: PostAuthorizationInput): Promise<Record<string, unknown>> {
  return { placeholder: true };
}
