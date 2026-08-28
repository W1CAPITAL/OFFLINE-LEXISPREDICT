# Schema LexisPredict Offline (= Supabase em planilha/JSON)

Tenant: `empresas` → tudo com `empresa_id`.

## Usuarios (aba + DB local)
| Coluna planilha | Campo | Obrigatório |
|-----------------|-------|-------------|
| login | login único | sim |
| nome | nome | sim |
| senha | SHA-256 hex | sim |
| perfil | superadmin\|supervisor\|administrador\|operador\|assistente | sim |
| escritorio | texto | não |
| ativo | sim\|nao | sim |
| email | e-mail | recomendado |
| auth_user_id | UUID | gerado pelo app |
| id | UUID linha | gerado |

## Processos
Chave: protocolo_ref (CNJ). Dono: created_by = auth_user_id.
Campos quentes: cliente, status, situacao, ultimo_retorno, proximo_retorno, advogado, escritorio, tribunal, atendido_por, datajud_encerrado_tribunal, empresa_id.

## Outras abas
Notes, Honorarios, CarteiraValores, CrmServicos, AdvogadosBanca, KnowledgeDocs, KnowledgeChunks, AuditoriaLogins, AuditoriaLogsApp, ScanMetrics, AlertEvents, BaScanLogs — ver prompt mestre.

## Cargos
- superadmin: tudo + Equipe
- supervisor: carteira empresa inteira
- administrador: operacional (não gerencia superadmins)
- operador/assistente: só created_by = eu
