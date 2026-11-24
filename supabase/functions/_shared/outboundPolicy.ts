export interface OutboundPolicyCheckResult {
  ok: boolean;
  policy?: Record<string, unknown>;
  error?: string;
}

export async function checkOutboundPolicy(
  supabaseUrl: string,
  workerSecret: string,
  outboundActionId: string,
): Promise<OutboundPolicyCheckResult> {
  let response: Response;
  try {
    response = await fetch(
      `${supabaseUrl}/functions/v1/n8n-check-instagram-policy`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-secret": workerSecret,
        },
        body: JSON.stringify({ outbound_action_id: outboundActionId }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? `policy_check_unreachable:${error.name}`
        : "policy_check_unreachable",
    };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "policy_check_invalid_response" };
  }

  if (!response.ok || body?.ok !== true) {
    return {
      ok: false,
      error: typeof body?.error === "string"
        ? `policy_check_failed:${body.error}`
        : `policy_check_failed:http_${response.status}`,
    };
  }

  return {
    ok: true,
    policy: body.policy && typeof body.policy === "object"
      ? body.policy as Record<string, unknown>
      : {},
  };
}

