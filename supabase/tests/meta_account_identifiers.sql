begin;

create extension if not exists pgtap with schema extensions;
select plan(8);

select has_table(
  'public',
  'instagram_account_identifiers',
  'Meta account identifier alias table exists'
);

insert into public.organizations (id, name, slug)
values
  ('61000000-0000-0000-0000-000000000001', 'Meta Alias Org A', 'meta-alias-org-a'),
  ('61000000-0000-0000-0000-000000000002', 'Meta Alias Org B', 'meta-alias-org-b');

insert into public.instagram_accounts (
  id,
  organization_id,
  external_id,
  username,
  status
)
values
  (
    '62000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000001',
    'legacy-account-a',
    'alias.a',
    'active'
  ),
  (
    '62000000-0000-0000-0000-000000000002',
    '61000000-0000-0000-0000-000000000002',
    'legacy-account-b',
    'alias.b',
    'active'
  );

insert into public.instagram_account_identifiers (
  instagram_account_id,
  organization_id,
  auth_mode,
  identifier_type,
  external_id
)
values
  (
    '62000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000001',
    'unified_login',
    'api_user_id',
    'unified-api-a'
  ),
  (
    '62000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000001',
    'unified_login',
    'webhook_entry_id',
    'unified-webhook-a'
  );

select is(
  (
    select external_id
    from public.instagram_account_identifiers
    where instagram_account_id = '62000000-0000-0000-0000-000000000001'
      and auth_mode = 'unified_login'
      and identifier_type = 'api_user_id'
      and status = 'active'
      and is_primary
  ),
  'unified-api-a',
  'Unified API user ID resolves independently from the webhook entry ID'
);

select throws_ok(
  $$
    insert into public.instagram_account_identifiers (
      instagram_account_id, organization_id, auth_mode, identifier_type, external_id
    ) values (
      '62000000-0000-0000-0000-000000000002',
      '61000000-0000-0000-0000-000000000002',
      'unified_login',
      'api_user_id',
      'unified-api-a'
    )
  $$,
  '23505',
  null,
  'A provider identifier cannot belong to two accounts'
);

select throws_ok(
  $$
    insert into public.instagram_account_identifiers (
      instagram_account_id, organization_id, auth_mode, identifier_type, external_id
    ) values (
      '62000000-0000-0000-0000-000000000001',
      '61000000-0000-0000-0000-000000000002',
      'unified_login',
      'token_user_id',
      'cross-tenant-id'
    )
  $$,
  '23503',
  null,
  'Composite foreign key rejects a cross-tenant alias'
);

select throws_ok(
  $$
    insert into public.instagram_account_identifiers (
      instagram_account_id, organization_id, auth_mode, identifier_type, external_id
    ) values (
      '62000000-0000-0000-0000-000000000001',
      '61000000-0000-0000-0000-000000000001',
      'unsupported_login',
      'token_user_id',
      'bad-mode-id'
    )
  $$,
  '23514',
  null,
  'Unsupported authentication modes are rejected'
);

select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.instagram_account_identifiers'::regclass
  ),
  'Row level security is enabled'
);

select ok(
  not has_table_privilege('anon', 'public.instagram_account_identifiers', 'select'),
  'anon cannot read Meta identifiers'
);

select ok(
  has_table_privilege('service_role', 'public.instagram_account_identifiers', 'select'),
  'service_role can resolve Meta identifiers'
);

select * from finish();
rollback;
