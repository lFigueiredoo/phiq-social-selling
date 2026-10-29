begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

do $test$
declare
  v_org uuid := gen_random_uuid();
  v_account uuid := gen_random_uuid();
  v_event uuid;
  v_job uuid;
  v_prepared jsonb;
  v_classification jsonb := '{
    "intent":"engagement",
    "commercial_potential":"low",
    "lead_score":5,
    "route_type":"no_profile",
    "confidence":0.3,
    "reason":"generic engagement",
    "recommended_next_action":"await_new_signal",
    "signals":["generic_engagement"],
    "needs_more_signal":true
  }'::jsonb;
  v_saved record;
  v_source text;
  v_payload jsonb;
begin
  insert into public.organizations(id, name) values(v_org, 'response-draft-test');
  insert into public.instagram_accounts(id, organization_id, external_id, username, status)
  values(v_account, v_org, 'draft-account', 'phiq-test', 'active');

  foreach v_source in array array['realtime', 'historical_backfill'] loop
    v_event := gen_random_uuid();
    v_job := gen_random_uuid();
    v_payload := jsonb_build_object(
      'source', v_source,
      'entry', jsonb_build_array(jsonb_build_object(
        'id', 'draft-account',
        'changes', jsonb_build_array(jsonb_build_object(
          'field', 'comments',
          'value', jsonb_build_object(
            'id', 'comment-' || v_source,
            'text', 'Parabéns pelo conteúdo',
            'from', jsonb_build_object('id', 'person-' || v_source, 'username', 'cliente')
          )
        ))
      ))
    );

    insert into public.webhook_events(
      id, organization_id, instagram_account_id, object_type, event_type,
      external_object_id, idempotency_key, payload, status
    ) values (
      v_event, v_org, v_account, 'instagram', 'comments',
      'comment-' || v_source, 'draft:' || v_source, v_payload, 'processing'
    );
    insert into public.processing_jobs(
      id, organization_id, webhook_event_id, job_type, status, locked_at, locked_by, attempts
    ) values (
      v_job, v_org, v_event, 'process_instagram_comment', 'processing', now(), 'draft-worker', 1
    );

    v_prepared := public.prepare_social_engagement_pipeline(jsonb_build_object(
      'organization_id', v_org,
      'instagram_account_id', v_account,
      'external_user_id', 'person-' || v_source,
      'username', 'cliente',
      'engagement_type', 'comment',
      'external_engagement_id', 'comment-' || v_source,
      'webhook_event_id', v_event,
      'text', 'Parabéns pelo conteúdo',
      'source', v_source,
      'occurred_at', now()
    ));
    perform public.complete_social_engagement_pipeline(
      v_org,
      (v_prepared ->> 'lead_id')::uuid,
      (v_prepared ->> 'engagement_id')::uuid,
      v_classification,
      'deterministic',
      'SOCIAL_SELLING_CLASSIFIER_V1'
    );

    select * into v_saved
    from public.save_instagram_response_draft(
      v_job,
      'draft-worker',
      'Obrigado pelo carinho! Ficamos felizes com seu comentário.',
      'positive',
      'Resposta cordial e sem promessa comercial.',
      'models/gemini-3-flash-preview',
      'SOCIAL_REPLY_DRAFT_V1'
    );

    if v_saved.outbound_status <> 'proposed'
       or v_saved.action_type <> 'public_reply'
       or v_saved.source <> v_source
       or v_saved.already_exists then
      raise exception 'draft persistence contract failed for %: %', v_source, v_saved;
    end if;
    if not exists (
      select 1 from public.outbound_actions
      where id = v_saved.outbound_action_id
        and processing_job_id = v_job
        and status = 'proposed'
        and action_type = 'public_reply'
        and policy_check_status = 'not_required'
        and approved_at is null
        and sent_at is null
    ) then
      raise exception 'draft was not persisted safely for %', v_source;
    end if;

    select * into v_saved
    from public.save_instagram_response_draft(
      v_job,
      'draft-worker',
      'Texto de retry que não pode substituir uma ação existente.',
      'neutral',
      'Retry idempotente.',
      'models/gemini-3-flash-preview',
      'SOCIAL_REPLY_DRAFT_V1'
    );
    if not v_saved.already_exists
       or (select count(*) from public.outbound_actions where processing_job_id = v_job) <> 1
       or (select message_text from public.outbound_actions where processing_job_id = v_job)
          <> 'Obrigado pelo carinho! Ficamos felizes com seu comentário.' then
      raise exception 'draft replay was not idempotent for %', v_source;
    end if;
    if (select count(*) from public.save_instagram_response_draft(
      v_job, 'other-worker', 'Nunca grava', 'neutral', 'Worker incorreto.',
      'models/gemini-3-flash-preview', 'SOCIAL_REPLY_DRAFT_V1'
    )) <> 0 then
      raise exception 'wrong worker persisted a draft';
    end if;
  end loop;

  if (select count(*) from public.outbound_actions where organization_id = v_org) <> 2 then
    raise exception 'unexpected number of proposed drafts';
  end if;
end
$test$;

set local role authenticated;
do $denied$
declare
  v_denied boolean := false;
begin
  begin
    perform public.save_instagram_response_draft(
      gen_random_uuid(), 'browser', 'Texto', 'neutral', 'Resumo', 'model', 'prompt'
    );
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then raise exception 'browser executed response draft RPC'; end if;
end
$denied$;
reset role;

select extensions.pass('Gemini response drafts are public, proposed, idempotent and worker-only');
select * from extensions.finish();
rollback;
