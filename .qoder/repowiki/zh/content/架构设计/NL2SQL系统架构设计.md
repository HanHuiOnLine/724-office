我需要分析代码变更以更新架构文档，重点关注实体解析系统的性能优化策略。让我先搜索相关的实体解析和性能优化相关代码。

<search_codebase>
<query>
entity resolution performance optimization single query loop replacement two-phase matching ambiguity detection entity tracking system
</query>
<file_pattern>
*.js
</file_pattern>
</search_codebase>

现在让我读取关键的源代码文件来了解实体解析系统的性能优化策略：

<read_file>
<path>
NL2SQL/backend/src/core/nl2sqlEngine.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/memory/longTermMemory.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/memory/vectorStore.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/core/schemaLoader.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/utils/evaluation.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/core/selfRepair.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/utils/tokenBudget.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/memory/summarizer.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/core/llmService.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/core/database.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/core/config.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/utils/logger.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/core/wsHandler.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/core/routes.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/src/app.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/frontend/src/main.js
</path>
</read_file>

<read_file>
<path>
NL2SQL/frontend/package.json
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/package.json
</path>
</read_file>

<read_file>
<path>
README.md
</path>
</read_file>

<read_file>
<path>
NL2SQL/backend/test/context-management.test.js
</path>
</read_file>