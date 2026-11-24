-- Fatos comerciais públicos conferidos nas páginas oficiais da PHIQ em
-- 24/11/2026. Não há preço, desconto ou garantia financeira presumida.

insert into public.social_catalog_offers(
  organization_id,route_type,offer_kind,name,summary,audience,
  approved_claims,prohibited_claims,price_text,public_url,active,sort_order
)
select
  o.id,seed.route_type,seed.offer_kind,seed.name,seed.summary,seed.audience,
  seed.approved_claims,seed.prohibited_claims,seed.price_text,seed.public_url,true,
  seed.sort_order
from public.organizations o
cross join (values
  (
    'franchise','franchise','Franquia PHIQ',
    'Modelo de franquia voltado à comercialização de soluções de higienização profissional, com treinamento e suporte técnico e comercial.',
    'Pessoas interessadas em empreender no mercado de higienização profissional.',
    jsonb_build_array(
      'A PHIQ informa oferecer treinamento e suporte técnico e comercial aos franqueados.',
      'O portfólio atende setores como saúde, alimentação, lavanderias industriais e agronegócio.',
      'O investimento depende do plano e da região e deve ser apresentado pela equipe comercial.'
    ),
    jsonb_build_array(
      'Não garantir lucro, faturamento, payback ou retorno financeiro.',
      'Não informar valor de investimento, taxa, território ou prazo contratual sem validação comercial.',
      'Não afirmar aprovação automática do candidato.'
    ),
    'Sob consulta','https://phiq.com.br/franquia-phiq/',10
  ),
  (
    'q3','service','PHIQ Q³',
    'Programa de Higienização Integrada que reúne Qualidade, Química e Qualificação para padronizar, documentar e acompanhar processos de higienização.',
    'Operações industriais, hospitalares, institucionais, alimentícias, agroindustriais e lavanderias que precisam de controle e rastreabilidade.',
    jsonb_build_array(
      'O Q³ começa por diagnóstico técnico e pode incluir padronização, documentação, treinamento e acompanhamento contínuo.',
      'Os DOCs Q organizam procedimentos, registros, checklists, indicadores e evidências para auditorias.',
      'A solução é definida conforme a realidade operacional do cliente.'
    ),
    jsonb_build_array(
      'Não prometer aprovação em auditoria, ausência de autuação ou eliminação total de riscos.',
      'Não informar preço, prazo de implantação ou escopo fechado sem diagnóstico.',
      'Não afirmar que o cliente precisa trocar todos os produtos atuais.'
    ),
    'Sob consulta','https://phiq.com.br/q3/',20
  ),
  (
    null,'product','Produtos PHIQ',
    'Linhas de produtos para higienização profissional desenvolvidas para eficiência, segurança e sustentabilidade em diferentes operações.',
    'Empresas dos setores alimentício, avícola, bebidas, higiene geral, hospitalar, industrial, lavanderia e suinocultura.',
    jsonb_build_array(
      'A PHIQ mantém linhas para os setores alimentício, avícola, bebidas, higiene geral, hospitalar, industrial, lavanderia e suinocultura.',
      'A indicação do produto deve considerar o setor, a aplicação e o desafio de higienização.',
      'A equipe técnica pode orientar a solução adequada para cada operação.'
    ),
    jsonb_build_array(
      'Não indicar produto, dosagem, diluição, tempo de contato ou aplicação sem avaliação técnica.',
      'Não prometer eliminação total de microrganismos ou resultado clínico.',
      'Não informar preço, disponibilidade ou desconto sem validação comercial.'
    ),
    'Sob consulta','https://phiq.com.br/produtos/',30
  ),
  (
    null,'service','PHIQ LAB — Análises de Água',
    'Serviços de análises físico-químicas e microbiológicas de água, com suporte desde a definição da análise e coleta até a entrega dos resultados.',
    'Empresas que precisam controlar água de processo, consumo, poço, bebidas, lavagem, CIP, caldeiras, piscinas ou reuso.',
    jsonb_build_array(
      'O PHIQ LAB realiza análises físico-químicas e microbiológicas conforme a necessidade do cliente.',
      'O atendimento inicial informado pela PHIQ abrange PB, PE e RN.',
      'Os parâmetros devem ser definidos conforme o tipo de água e a finalidade do processo.'
    ),
    jsonb_build_array(
      'Não garantir conformidade, potabilidade ou aprovação antes da análise.',
      'Não afirmar cobertura geográfica fora de PB, PE e RN sem confirmação.',
      'Não informar prazo, preço ou escopo de laudo sem validação do laboratório.'
    ),
    'Sob consulta','https://phiq.com.br/PhiqLab/',40
  ),
  (
    null,'service','BioHub InovaPHIQ',
    'Centro de pesquisa e desenvolvimento para formulação, desenvolvimento e produção em escala de saneantes e cosméticos.',
    'Empresas e empreendedores que procuram desenvolvimento ou fabricação customizada de saneantes e cosméticos.',
    jsonb_build_array(
      'O InovaPHIQ informa atuar em desenvolvimento de fórmulas, controle de qualidade e produção em escala.',
      'O serviço pode incluir fabricação, rotulagem e embalagem conforme o projeto.',
      'O escopo deve ser definido com a equipe técnica.'
    ),
    jsonb_build_array(
      'Não prometer fórmula exclusiva, licença, registro ou prazo regulatório sem análise do projeto.',
      'Não garantir capacidade, lote mínimo, preço ou prazo sem validação técnica e comercial.',
      'Não afirmar que qualquer formulação pode ser produzida.'
    ),
    'Sob consulta','https://phiq.com.br/inovaphiq/',50
  )
) as seed(
  route_type,offer_kind,name,summary,audience,approved_claims,
  prohibited_claims,price_text,public_url,sort_order
)
on conflict (organization_id,name) do update set
  route_type=excluded.route_type,
  offer_kind=excluded.offer_kind,
  summary=excluded.summary,
  audience=excluded.audience,
  approved_claims=excluded.approved_claims,
  prohibited_claims=excluded.prohibited_claims,
  price_text=excluded.price_text,
  public_url=excluded.public_url,
  active=true,
  sort_order=excluded.sort_order;

-- Registros-base sem página oficial ou fatos aprovados não devem alimentar o
-- modelo até que a equipe comercial os complete no painel.
update public.social_catalog_offers
set active=false
where name in ('Cursos','NUY Creators')
  and summary=''
  and approved_claims='[]'::jsonb;
