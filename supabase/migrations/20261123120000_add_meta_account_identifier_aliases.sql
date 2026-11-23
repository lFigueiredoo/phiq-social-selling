create table public.instagram_account_identifiers (
  id uuid primary key default gen_random_uuid(),
  instagram_account_id uuid not null,
  organization_id uuid not null,
  auth_mode text not null check (auth_mode in ('instagram_login', 'unified_login')),
  identifier_type text not null check (identifier_type in ('api_user_id', 'webhook_entry_id', 'token_user_id')),
  external_id text not null check (btrim(external_id) <> ''),
  is_primary boolean not null default true,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint instagram_account_identifiers_account_org_fk
    foreign key (instagram_account_id, organization_id)
    references public.instagram_accounts (id, organization_id)
    on delete cascade,
  constraint instagram_account_identifiers_provider_id_unique
    unique (auth_mode, identifier_type, external_id),
  constraint instagram_account_identifiers_account_value_unique
    unique (instagram_account_id, auth_mode, identifier_type, external_id)
);

comment on table public.instagram_account_identifiers is
  'Mapeia os diferentes namespaces de IDs que a Meta pode usar para API, token e webhook durante a coexistência entre Instagram Login e Unified Login.';

comment on column public.instagram_account_identifiers.external_id is
  'Identificador sem credencial. Tokens e segredos continuam exclusivamente no secret store.';

create unique index instagram_account_identifiers_one_primary_active
  on public.instagram_account_identifiers (
    instagram_account_id,
    auth_mode,
    identifier_type
  )
  where is_primary and status = 'active';

create index instagram_account_identifiers_account_idx
  on public.instagram_account_identifiers (instagram_account_id, status);

create trigger set_updated_at_instagram_account_identifiers
  before update on public.instagram_account_identifiers
  for each row execute function public.set_updated_at();

alter table public.instagram_account_identifiers enable row level security;

revoke all on table public.instagram_account_identifiers from anon, authenticated;
grant select, insert, update, delete on table public.instagram_account_identifiers to service_role;

insert into public.instagram_account_identifiers (
  instagram_account_id,
  organization_id,
  auth_mode,
  identifier_type,
  external_id,
  is_primary,
  status
)
select
  account.id,
  account.organization_id,
  'instagram_login',
  identifier.identifier_type,
  account.external_id,
  true,
  'active'
from public.instagram_accounts as account
cross join (
  values ('api_user_id'::text), ('webhook_entry_id'::text)
) as identifier(identifier_type)
on conflict do nothing;
