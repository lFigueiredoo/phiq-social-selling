-- O trigger de cancelamento pode mudar status/last_error durante um UPDATE
-- que nomeou apenas os campos de destino. Em PostgreSQL, um trigger
-- "UPDATE OF status" considera as colunas do SET original, não as mudanças
-- feitas por um BEFORE trigger. Escutar todo UPDATE garante o log de qualquer
-- retargetização para a própria conta; a função mantém a condição estrita.

drop trigger if exists audit_self_targeted_outbound_cancellation
on public.outbound_actions;

create trigger audit_self_targeted_outbound_cancellation
after insert or update
on public.outbound_actions
for each row execute function public.audit_self_targeted_outbound_cancellation();

