-- F22E: one catalog for every commercial stage and allowed automatic edge.
create table public.social_vertical_stages (
  route_type text not null check (route_type in ('franchise','q3','hotmart','nuy')),
  stage text not null,
  position smallint not null check (position > 0),
  label_pt text not null,
  recommended_next_action text not null,
  terminal boolean not null default false,
  primary key (route_type, stage),
  unique (route_type, position)
);
insert into public.social_vertical_stages values
('franchise','lead_received',1,'Lead Recebido','review_profile',false),
('franchise','presentation',2,'Apresentação','present_franchise',false),
('franchise','evaluation',3,'Avaliação','evaluate_candidate',false),
('franchise','proposal',4,'Proposta','prepare_proposal',false),
('franchise','negotiation',5,'Negociação','follow_negotiation',false),
('franchise','closing',6,'Fechamento','confirm_closing',false),
('franchise','implementation',7,'Implantação','monitor_implementation',true),
('q3','lead_received',1,'Lead Recebido','review_company',false),
('q3','diagnosis',2,'Diagnóstico','perform_diagnosis',false),
('q3','presentation',3,'Apresentação','present_q3',false),
('q3','proposal',4,'Proposta','prepare_proposal',false),
('q3','negotiation',5,'Negociação','follow_negotiation',false),
('q3','onboarding',6,'Onboarding','start_onboarding',false),
('q3','active_client',7,'Cliente Ativo','customer_success',true),
('hotmart','lead_received',1,'Lead Recebido','understand_learning_need',false),
('hotmart','course_recommendation',2,'Indicação do Curso','recommend_course',false),
('hotmart','offer',3,'Oferta','present_offer',false),
('hotmart','follow_up',4,'Follow-up','follow_up',false),
('hotmart','purchase',5,'Compra','confirm_purchase',false),
('hotmart','active_student',6,'Aluno Ativo','student_success',true),
('nuy','lead_received',1,'Lead Recebido','understand_need',false),
('nuy','need_identification',2,'Identificação da Necessidade','identify_need',false),
('nuy','product_recommendation',3,'Indicação dos Produtos','recommend_products',false),
('nuy','offer',4,'Oferta','present_offer',false),
('nuy','purchase',5,'Compra','confirm_purchase',false),
('nuy','post_sale',6,'Pós-venda','post_sale_follow_up',true);

create table public.social_vertical_transitions (
  route_type text not null,
  from_stage text not null,
  to_stage text not null,
  primary key (route_type, from_stage, to_stage),
  foreign key (route_type, from_stage) references public.social_vertical_stages(route_type,stage),
  foreign key (route_type, to_stage) references public.social_vertical_stages(route_type,stage)
);
insert into public.social_vertical_transitions
select a.route_type, a.stage, b.stage from public.social_vertical_stages a
join public.social_vertical_stages b on b.route_type=a.route_type and b.position=a.position+1;
alter table public.social_vertical_stages enable row level security;
alter table public.social_vertical_transitions enable row level security;
revoke all on public.social_vertical_stages, public.social_vertical_transitions from public, anon, authenticated, service_role;
grant select on public.social_vertical_stages, public.social_vertical_transitions to service_role;

-- Existing installations may contain the two F22C spelling variants.
update public.social_leads set vertical_stage='need_identification'
  where route_type='nuy' and vertical_stage='needs_identification';
update public.social_leads set vertical_stage='post_sale'
  where route_type='nuy' and vertical_stage='after_sales';
update public.social_lead_stage_history set from_stage='need_identification'
  where pipeline='nuy' and from_stage='needs_identification';
update public.social_lead_stage_history set to_stage='need_identification'
  where pipeline='nuy' and to_stage='needs_identification';
update public.social_lead_stage_history set from_stage='post_sale'
  where pipeline='nuy' and from_stage='after_sales';
update public.social_lead_stage_history set to_stage='post_sale'
  where pipeline='nuy' and to_stage='after_sales';

create or replace function public.social_vertical_stage_position(p_route text,p_stage text)
returns integer language sql stable security invoker set search_path = '' as $$
  select position::integer from public.social_vertical_stages
  where route_type=p_route and stage=p_stage
$$;

alter table public.social_leads drop constraint social_leads_status_check;
alter table public.social_leads add constraint social_leads_status_check
  check (status in ('active','awaiting_signal','won','lost','cancelled'));
alter table public.social_leads drop constraint social_leads_check1;
alter table public.social_leads add constraint social_leads_route_status_check
  check ((route_type = 'no_profile' and status in ('awaiting_signal','lost','cancelled') and vertical_stage is null)
    or (route_type is distinct from 'no_profile' and status <> 'awaiting_signal'));
alter table public.social_leads
  add column owner_user_id uuid,
  add column vertical_stage_entered_at timestamptz,
  add column closed_at timestamptz,
  add column won_at timestamptz,
  add column lost_at timestamptz,
  add constraint social_leads_owner_membership_fk foreign key (organization_id,owner_user_id)
    references public.organization_members(organization_id,user_id);
alter table public.social_lead_stage_history
  add column route_type text,
  add column from_status text,
  add column to_status text,
  add column operation_key text,
  add constraint social_history_details_size check (pg_column_size(details) <= 4096),
  add constraint social_history_operation_key_size check (operation_key is null or length(operation_key) between 1 and 120);
create unique index social_history_operation_key_unique
  on public.social_lead_stage_history(organization_id,operation_key) where operation_key is not null;
alter table public.social_lead_stage_history drop constraint social_lead_stage_history_source_check;
alter table public.social_lead_stage_history add constraint social_lead_stage_history_source_check
  check (source in ('system','ai','human','manual','import'));

create function public.social_vertical_lead_sync() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_stage public.social_vertical_stages%rowtype;
begin
  if old.status in ('lost','cancelled') and new.status in ('active','awaiting_signal')
    and current_setting('app.social_status_reopen_authorized',true) is distinct from new.id::text then
    raise exception 'manual_reopen_required' using errcode='22023';
  end if;
  if new.vertical_stage is distinct from old.vertical_stage or new.route_type is distinct from old.route_type then
    if new.vertical_stage is not null then
      select * into v_stage from public.social_vertical_stages
        where route_type=new.route_type and stage=new.vertical_stage;
      if not found then raise exception 'invalid_vertical_stage' using errcode='22023'; end if;
      new.vertical_stage_entered_at := clock_timestamp();
      new.recommended_next_action := v_stage.recommended_next_action;
      if v_stage.terminal then
        new.status := 'won'; new.won_at := coalesce(new.won_at,clock_timestamp());
        new.closed_at := clock_timestamp();
      elsif old.status = 'won' then
        new.status := 'active'; new.closed_at := null;
      end if;
    else
      new.vertical_stage_entered_at := null;
      if new.route_type='no_profile' then new.recommended_next_action := 'await_new_signal'; end if;
    end if;
  end if;
  if new.status is distinct from old.status then
    if new.status in ('lost','cancelled') then
      new.closed_at := clock_timestamp();
      if new.status='lost' then new.lost_at := clock_timestamp(); end if;
    elsif new.status='active' then new.closed_at := null;
    end if;
  end if;
  return new;
end $$;
create trigger social_vertical_lead_sync_before before update on public.social_leads
  for each row execute function public.social_vertical_lead_sync();

create function public.social_vertical_history_enrich() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype;
begin
  select * into v_lead from public.social_leads where id=new.lead_id and organization_id=new.organization_id;
  new.route_type := coalesce(new.route_type,v_lead.route_type);
  new.from_status := coalesce(new.from_status,v_lead.status);
  new.to_status := coalesce(new.to_status,v_lead.status);
  return new;
end $$;
create trigger social_vertical_history_enrich_before before insert on public.social_lead_stage_history
  for each row execute function public.social_vertical_history_enrich();

create or replace function public.route_social_lead(
  p_organization_id uuid,p_lead_id uuid,p_route_type text,p_confidence numeric,
  p_lead_score integer,p_reason text,p_recommended_next_action text,p_source text,p_changed_by_type text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype; v_after public.social_leads%rowtype;
begin
  if p_source is null or p_source not in ('system','ai','import') or p_changed_by_type <> 'system'
    then raise exception 'manual_route_requires_verified_actor' using errcode='22023'; end if;
  if p_route_type is null or p_route_type not in ('franchise','q3','hotmart','nuy','no_profile')
    or p_confidence is null or p_confidence<0 or p_confidence>1
    or p_lead_score is null or p_lead_score<0 or p_lead_score>100
    or nullif(btrim(p_reason),'') is null or nullif(btrim(p_recommended_next_action),'') is null
    then raise exception 'invalid_route_contract' using errcode='22023'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id and organization_id=p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
  if v_lead.central_stage<>'routing' then raise exception 'routing_stage_required' using errcode='22023'; end if;
  if v_lead.status not in ('active','awaiting_signal') then raise exception 'closed_lead' using errcode='22023'; end if;
  if v_lead.route_type=p_route_type then raise exception 'route_unchanged' using errcode='22023'; end if;
  update public.social_leads set route_type=p_route_type,route_confidence=p_confidence,
    lead_score=p_lead_score,route_reason=p_reason,
    recommended_next_action=p_recommended_next_action,
    vertical_stage=case when p_route_type='no_profile' then null else 'lead_received' end,
    status=case when p_route_type='no_profile' then 'awaiting_signal' else 'active' end,
    routed_at=clock_timestamp() where id=p_lead_id returning * into v_after;
  insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,from_stage,to_stage,
    reason,source,changed_by_type,route_type,from_status,to_status,details)
    values (p_organization_id,p_lead_id,'central',v_lead.route_type,p_route_type,
      p_reason,p_source,p_changed_by_type,p_route_type,v_lead.status,v_after.status,
      jsonb_build_object('previous_route',v_lead.route_type,'new_route',p_route_type));
  if p_route_type<>'no_profile' then
    insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,from_stage,to_stage,
      reason,source,changed_by_type,route_type,from_status,to_status)
      values(p_organization_id,p_lead_id,p_route_type,v_lead.vertical_stage,'lead_received',
        p_reason,p_source,p_changed_by_type,p_route_type,v_lead.status,v_after.status);
  end if;
  return p_lead_id;
end $$;

-- Both old and new callers use the same catalog; the older RPC retains its API.
create or replace function public.transition_social_lead_stage(
  p_organization_id uuid,p_lead_id uuid,p_pipeline text,p_to_stage text,
  p_reason text,p_source text,p_changed_by_type text,p_human_override boolean default false
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype; v_after public.social_leads%rowtype; v_from text;
begin
  if nullif(btrim(p_reason),'') is null then raise exception 'reason_required' using errcode='22023'; end if;
  if p_human_override or p_source not in ('system','ai','import') or p_changed_by_type<>'system' then
    raise exception 'manual_override_requires_verified_actor' using errcode='22023'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id and organization_id=p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
  if p_pipeline='central' then
    v_from:=v_lead.central_stage;
    if not exists(select 1 from public.social_central_transitions t where t.from_stage=v_from and t.to_stage=p_to_stage
      and (t.condition='always' or (t.condition='new_signal' and v_lead.route_type='no_profile')))
      then raise exception 'invalid_central_transition' using errcode='22023'; end if;
    update public.social_leads set central_stage=p_to_stage,
      route_type=case when p_to_stage='qualification' then null else route_type end,
      vertical_stage=case when p_to_stage='qualification' then null else vertical_stage end,
      status=case when p_to_stage='qualification' then 'active' else status end,
      first_contact_at=case when p_to_stage='first_contact' then coalesce(first_contact_at,clock_timestamp()) else first_contact_at end,
      qualified_at=case when p_to_stage='qualification' then clock_timestamp() else qualified_at end,
      routed_at=case when p_to_stage='routing' then clock_timestamp() else routed_at end
      where id=p_lead_id returning * into v_after;
  elsif p_pipeline=v_lead.route_type and v_lead.central_stage='routing' and v_lead.status='active' then
    v_from:=v_lead.vertical_stage;
    if not exists(select 1 from public.social_vertical_transitions t
      where t.route_type=p_pipeline and t.from_stage=v_from and t.to_stage=p_to_stage)
      then raise exception 'invalid_vertical_transition' using errcode='22023'; end if;
    update public.social_leads set vertical_stage=p_to_stage where id=p_lead_id returning * into v_after;
  else raise exception 'invalid_pipeline' using errcode='22023'; end if;
  insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,from_stage,to_stage,
    reason,source,changed_by_type,route_type,from_status,to_status)
    values(p_organization_id,p_lead_id,p_pipeline,v_from,p_to_stage,p_reason,p_source,p_changed_by_type,
      v_after.route_type,v_lead.status,v_after.status);
  return p_lead_id;
end $$;

create function public.transition_vertical_lead_stage(
  p_organization_id uuid,p_lead_id uuid,p_expected_stage text,p_to_stage text,
  p_operation_key text,p_reason text,p_source text default 'system'
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype; v_after public.social_leads%rowtype;
begin
  if nullif(btrim(p_operation_key),'') is null or length(p_operation_key)>120
    or nullif(btrim(p_reason),'') is null or p_source not in ('system','ai','import')
    then raise exception 'invalid_transition_contract' using errcode='22023'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id and organization_id=p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
  if exists(select 1 from public.social_lead_stage_history h where h.organization_id=p_organization_id
    and h.operation_key=p_operation_key and h.lead_id=p_lead_id and h.pipeline=v_lead.route_type
    and h.from_stage=p_expected_stage and h.to_stage=p_to_stage and h.source=p_source
    and h.reason=p_reason)
    then return p_lead_id; end if;
  if exists(select 1 from public.social_lead_stage_history h where h.organization_id=p_organization_id
    and h.operation_key=p_operation_key) then raise exception 'operation_key_reused' using errcode='22023'; end if;
  if v_lead.central_stage<>'routing' or v_lead.status<>'active'
    or v_lead.vertical_stage is distinct from p_expected_stage
    or not exists(select 1 from public.social_vertical_transitions t
      where t.route_type=v_lead.route_type and t.from_stage=v_lead.vertical_stage and t.to_stage=p_to_stage)
    then raise exception 'invalid_vertical_transition' using errcode='22023'; end if;
  update public.social_leads set vertical_stage=p_to_stage where id=p_lead_id returning * into v_after;
  insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,from_stage,to_stage,
    reason,source,changed_by_type,route_type,from_status,to_status,operation_key)
    values(p_organization_id,p_lead_id,v_lead.route_type,v_lead.vertical_stage,p_to_stage,
      p_reason,p_source,'system',v_lead.route_type,v_lead.status,v_after.status,p_operation_key);
  return p_lead_id;
end $$;

create function public.manual_transition_vertical_lead_stage(
  p_organization_id uuid,p_lead_id uuid,p_actor_user_id uuid,p_to_stage text,
  p_operation_key text,p_reason text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype; v_after public.social_leads%rowtype;
begin
  if p_actor_user_id is null or nullif(btrim(p_reason),'') is null
    or nullif(btrim(p_operation_key),'') is null or length(p_operation_key)>120
    then raise exception 'invalid_manual_transition' using errcode='22023'; end if;
  if not exists(select 1 from public.organization_members m where m.organization_id=p_organization_id
    and m.user_id=p_actor_user_id and m.status='active' and m.role='admin')
    then raise exception 'active_admin_required' using errcode='42501'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id and organization_id=p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
  if exists(select 1 from public.social_lead_stage_history h where h.organization_id=p_organization_id
    and h.operation_key=p_operation_key and h.lead_id=p_lead_id and h.pipeline=v_lead.route_type
    and h.to_stage=p_to_stage and h.source='manual' and h.changed_by_id=p_actor_user_id
    and h.reason=p_reason)
    then return p_lead_id; end if;
  if v_lead.central_stage<>'routing' or v_lead.route_type not in ('franchise','q3','hotmart','nuy')
    or v_lead.status in ('lost','cancelled') or v_lead.vertical_stage=p_to_stage
    or not exists(select 1 from public.social_vertical_stages s
      where s.route_type=v_lead.route_type and s.stage=p_to_stage)
    then raise exception 'invalid_manual_transition' using errcode='22023'; end if;
  update public.social_leads set vertical_stage=p_to_stage where id=p_lead_id returning * into v_after;
  insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,from_stage,to_stage,
    reason,source,changed_by_type,changed_by_id,route_type,from_status,to_status,operation_key)
    values(p_organization_id,p_lead_id,v_lead.route_type,v_lead.vertical_stage,p_to_stage,
      p_reason,'manual','human',p_actor_user_id,v_lead.route_type,v_lead.status,v_after.status,p_operation_key);
  return p_lead_id;
end $$;

create function public.set_social_lead_status(
  p_organization_id uuid,p_lead_id uuid,p_actor_user_id uuid,p_to_status text,
  p_operation_key text,p_reason text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype; v_after public.social_leads%rowtype;
begin
  if p_actor_user_id is null or nullif(btrim(p_reason),'') is null
    or nullif(btrim(p_operation_key),'') is null or length(p_operation_key)>120
    or p_to_status not in ('lost','cancelled','active')
    then raise exception 'invalid_status_change' using errcode='22023'; end if;
  if not exists(select 1 from public.organization_members m where m.organization_id=p_organization_id
    and m.user_id=p_actor_user_id and m.status='active' and m.role='admin')
    then raise exception 'active_admin_required' using errcode='42501'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id and organization_id=p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
  if exists(select 1 from public.social_lead_stage_history h where h.organization_id=p_organization_id
    and h.operation_key=p_operation_key and h.lead_id=p_lead_id and h.to_status=p_to_status
    and h.source='manual' and h.changed_by_id=p_actor_user_id
    and h.details->>'field'='status' and h.reason=p_reason) then return p_lead_id; end if;
  if (p_to_status='active' and v_lead.status not in ('lost','cancelled'))
    or (p_to_status in ('lost','cancelled') and v_lead.status not in ('active','won','awaiting_signal'))
    then raise exception 'invalid_status_change' using errcode='22023'; end if;
  if p_to_status='active' then
    perform pg_catalog.set_config('app.social_status_reopen_authorized',p_lead_id::text,true);
  end if;
  update public.social_leads set status=p_to_status,
    central_stage=case when p_to_status='active' and v_lead.route_type='no_profile'
      then 'qualification' else central_stage end,
    route_type=case when p_to_status='active' and v_lead.route_type='no_profile'
      then null else route_type end
    where id=p_lead_id returning * into v_after;
  if p_to_status='active' then
    perform pg_catalog.set_config('app.social_status_reopen_authorized','',true);
  end if;
  insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,from_stage,to_stage,
    reason,source,changed_by_type,changed_by_id,route_type,from_status,to_status,operation_key,
    details)
    values(p_organization_id,p_lead_id,case when v_lead.route_type in ('franchise','q3','hotmart','nuy')
      then v_lead.route_type else 'central' end,
      coalesce(v_lead.vertical_stage,v_lead.central_stage),coalesce(v_lead.vertical_stage,v_lead.central_stage),
      p_reason,'manual','human',p_actor_user_id,v_lead.route_type,v_lead.status,v_after.status,p_operation_key,
      jsonb_build_object('field','status'));
  return p_lead_id;
end $$;

create function public.assign_social_lead_owner(
  p_organization_id uuid,p_lead_id uuid,p_actor_user_id uuid,p_owner_user_id uuid,
  p_operation_key text,p_reason text
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare v_lead public.social_leads%rowtype;
begin
  if p_actor_user_id is null or nullif(btrim(p_reason),'') is null
    or nullif(btrim(p_operation_key),'') is null or length(p_operation_key)>120
    then raise exception 'invalid_assignment' using errcode='22023'; end if;
  if not exists(select 1 from public.organization_members m where m.organization_id=p_organization_id
    and m.user_id=p_actor_user_id and m.status='active' and m.role='admin')
    then raise exception 'active_admin_required' using errcode='42501'; end if;
  if p_owner_user_id is not null and not exists(select 1 from public.organization_members m
    where m.organization_id=p_organization_id and m.user_id=p_owner_user_id and m.status='active')
    then raise exception 'active_owner_required' using errcode='42501'; end if;
  select * into v_lead from public.social_leads where id=p_lead_id and organization_id=p_organization_id for update;
  if not found then raise exception 'lead_not_found' using errcode='P0002'; end if;
  if exists(select 1 from public.social_lead_stage_history h where h.organization_id=p_organization_id
    and h.operation_key=p_operation_key and h.lead_id=p_lead_id and h.source='manual'
    and h.changed_by_id=p_actor_user_id and h.details->>'field'='owner_user_id'
    and h.details->>'to' is not distinct from p_owner_user_id::text
    and h.reason=p_reason) then return p_lead_id; end if;
  if v_lead.owner_user_id is not distinct from p_owner_user_id then
    raise exception 'owner_unchanged' using errcode='22023'; end if;
  update public.social_leads set owner_user_id=p_owner_user_id where id=p_lead_id;
  insert into public.social_lead_stage_history(organization_id,lead_id,pipeline,from_stage,to_stage,
    reason,source,changed_by_type,changed_by_id,route_type,from_status,to_status,operation_key,details)
    values(p_organization_id,p_lead_id,case when v_lead.route_type in ('franchise','q3','hotmart','nuy')
      then v_lead.route_type else 'central' end,
      coalesce(v_lead.vertical_stage,v_lead.central_stage),coalesce(v_lead.vertical_stage,v_lead.central_stage),
      p_reason,'manual','human',p_actor_user_id,v_lead.route_type,v_lead.status,v_lead.status,p_operation_key,
      jsonb_build_object('field','owner_user_id','from',v_lead.owner_user_id,'to',p_owner_user_id));
  return p_lead_id;
end $$;

revoke all on function public.transition_vertical_lead_stage(uuid,uuid,text,text,text,text,text),
  public.manual_transition_vertical_lead_stage(uuid,uuid,uuid,text,text,text),
  public.set_social_lead_status(uuid,uuid,uuid,text,text,text),
  public.assign_social_lead_owner(uuid,uuid,uuid,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.transition_vertical_lead_stage(uuid,uuid,text,text,text,text,text),
  public.manual_transition_vertical_lead_stage(uuid,uuid,uuid,text,text,text),
  public.set_social_lead_status(uuid,uuid,uuid,text,text,text),
  public.assign_social_lead_owner(uuid,uuid,uuid,uuid,text,text)
  to service_role;
