#!/usr/bin/env node

import { Command } from "commander";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { execFileSync } from "child_process";

// 윈도우 Git Bash 경로 왜곡 방지
if (
	!process.env.MSYS_NO_PATHCONV &&
	process.platform === "win32" &&
	(process.env.EXEPATH?.includes("Git") || process.env._?.includes("bash"))
) {
	try {
		execFileSync(process.execPath, process.argv.slice(1), {
			stdio: "inherit",
			env: { ...process.env, MSYS_NO_PATHCONV: "1" },
		});
		process.exit(0);
	} catch (e) {
		process.exit(1);
	}
}

dotenv.config();

const program = new Command();

program.name("gen-rq").description("Swagger 명세를 기반으로 TypeScript Interface와 TanStack Query 훅을 자동 생성합니다.").version("1.1.0");

program
	.argument("<apiPath>", "변환할 API 엔드포인트 경로 (예: /api/v1/user/search)")
	.option("-s, --swagger <url>", "회사의 Swagger JSON URL 주소")
	.option("-k, --key <string>", "LLM API Key")
	.option("-t, --type <string>", "강제 지정 타입 선택 (query 또는 mutation)")
	.action(async (apiPath: string, options) => {
		const provider = process.env.LLM_PROVIDER || "ollama";

		const swaggerUrl = options.swagger || process.env.SWAGGER_URL;
		const forceType = options.type;

		const apiKey = provider === "ollama" ? "ollama" : options.key || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;

		const baseURL =
			provider === "ollama"
				? process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1"
				: "https://generativelanguage.googleapis.com/v1beta/openai/";

		const model = provider === "ollama" ? process.env.OLLAMA_MODEL || "qwen2.5-coder:7b" : "gemini-3.5-flash";

		// 수동 옵션 오타 검증
		if (forceType && forceType !== "query" && forceType !== "mutation") {
			console.error('❌ 에러: -t (--type) 옵션은 오직 "query" 또는 "mutation"만 입력 가능합니다.');
			return;
		}

		if (!apiKey && provider !== "ollama") {
			console.error("❌ 에러: API Key가 없습니다. -k 옵션을 주거나 .env를 설정하세요.");
			return;
		}

		if (!swaggerUrl) {
			console.error("❌ 에러: Swagger JSON URL 주소가 없습니다. -s 옵션을 주거나 .env에 SWAGGER_URL을 설정하세요.");
			return;
		}

		try {
			console.log(`🌐 1. Swagger 명세 가져오는 중... (${swaggerUrl})`);
			const { data: swaggerJson } = await axios.get(swaggerUrl);

			console.log(`🔍 2. 입력한 API 경로 [${apiPath}] 탐색 및 명세 추출 중...`);

			const pathSpecs = swaggerJson.paths?.[apiPath];

			if (!pathSpecs) {
				console.error(`❌ 에러: Swagger에서 [${apiPath}] 경로를 찾을 수 없습니다. 경로를 다시 확인하세요.`);
				return;
			}

			const targetedSpec = JSON.stringify(
				{
					path: apiPath,
					specs: pathSpecs,
				},
				null,
				2,
			);

			console.log(`🤖 3. AI 엔진을 통해 TypeScript 코드 생성 중...`);

			const openai = new OpenAI({
				apiKey,
				baseURL,
			});

			const systemPrompt = `
당신은 고도로 숙련된 프론트엔드 아키텍트이자 TypeScript 전문가입니다. 
제공된 백엔드 Swagger API 명세를 분석하여, 프로젝트에 바로 쓸 수 있는 완벽한 TypeScript Interface와 TanStack Query(React Query v5) 커스텀 훅을 생성하세요.

[★핵심 규칙: 사내 POST 통일 인프라 환경 대응★]
이 회사의 백엔드 시스템은 보안 및 기술 컨벤션상 모든 API 요청을 HTTP 'POST' 메서드로 처리합니다. 
따라서 단순히 HTTP Method가 POST라는 이유로 useMutation을 생성하면 안 됩니다. 당신은 'Endpoint 경로(URL)'와 'Summary/Description(설명)'의 문맥을 분석하여 Query와 Mutation을 정교하게 판별해야 합니다.

1. 'useQuery'를 생성해야 하는 문맥 가이드라인:
   - API 경로 이름이나 설명(summary/description)에 데이터 조회 성격의 단어가 있다면 반드시 'useQuery' 훅으로 생성하세요.
     (예: get, fetch, list, detail, info, search, check, select, view, '조회', '상세', '리스트', '내역')
   - 단, 실제 네트워크 요청 코드는 백엔드 스펙에 맞게 'axiosInstance.post' 메서드를 유지해야 합니다.

2. 'useMutation'을 생성해야 하는 문맥 가이드라인:
   - API 경로 이름이나 설명에 데이터 변경(서버 상태 조작) 성격의 단어가 있다면 'useMutation' 훅으로 생성하세요.
     (예: create, add, update, modify, delete, remove, save, upload, cancel, '등록', '수정', '삭제', '업로드', '취소')

[TypeScript 타입 지정 규칙]
1. 절대 'any' 타입을 사용하지 마세요. 모든 필드는 명확한 타입(string, number, boolean, 혹은 하위 interface)으로 정의되어야 합니다.
2. API 응답 및 요청 데이터 구조가 중첩 객체(Nested Object)나 배열인 경우, 하위 interface를 명확히 분리하여 정의하세요.

[출력 포맷 가이드]
- 마크다운 블록(\`\`\`typescript ... \`\`\`)을 절대로 포함하지 마세요.
- 오직 컴파일이 바로 가능한 순수한 TypeScript 코드만 리턴하세요. 설명이나 주석은 일절 금지합니다.
`;

			const userPrompt = `
다음 Swagger API 명세를 바탕으로 코드를 생성해줘:
${targetedSpec}

${
	forceType
		? `[🚨 개발자 수동 강제 사항]: 이 API는 문맥 분석 결과를 무시하고, 무조건 TanStack Query의 'use${
				forceType.charAt(0).toUpperCase() + forceType.slice(1)
			}' 형태로 코드를 생성해야 합니다.`
		: ""
}
`;

			const response = await openai.chat.completions.create({
				model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				temperature: 0.1,
			});

			const generatedCode = response.choices[0].message?.content;

			if (!generatedCode) {
				console.error("❌ 에러: AI가 코드를 생성하는 데 실패했습니다.");
				return;
			}

			// 로컬 모델 markdown 방어
			const cleanedCode = generatedCode
				.replace(/```typescript/g, "")
				.replace(/```/g, "")
				.trim();

			// 4. 파일 생성 처리
			const segments = apiPath.split("/").filter(Boolean);
			const lastSegment = segments[segments.length - 1] || "Api";

			const fileName = `use${lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1)}`;

			const targetDir = path.join(process.cwd(), "src", "hooks", "queries");

			if (!fs.existsSync(targetDir)) {
				fs.mkdirSync(targetDir, { recursive: true });
			}

			const filePath = path.join(targetDir, `${fileName}.ts`);

			fs.writeFileSync(filePath, cleanedCode, "utf8");

			console.log(`\n✨ 성공! TypeScript Interface와 Query 훅 파일이 생성되었습니다.`);
			console.log(`📁 파일 생성 위치: ${filePath}`);

			if (provider === "ollama") {
				console.log(`🖥️ Local Model: ${model}`);
			}

			if (forceType) {
				console.log(`🛠️ 적용 옵션: 개발자 강제 지정을 통해 [use${forceType.charAt(0).toUpperCase() + forceType.slice(1)}] 훅으로 빌드됨`);
			}
		} catch (error: any) {
			console.error("\n❌ 실행 중 치명적인 오류가 발생했습니다.");

			if (provider === "ollama" && (error.code === "ECONNREFUSED" || error.message?.includes("fetch"))) {
				console.error("💡 [Ollama 연결 실패] 로컬 Ollama 엔진이 실행 중인지 확인하세요!");
				console.error("   1. Ollama 앱이 켜져 있는지 확인 (트레이 아이콘)");
				console.error("   2. 터미널에 'ollama run qwen2.5-coder:7b' 가 정상 구동 중인지 확인");
			} else {
				console.error(`📝 에러 내용: ${error.message}`);
			}
		}
	});

program.parse(process.argv);
