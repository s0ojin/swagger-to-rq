#!/usr/bin/env node

import { Command } from "commander";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { execFileSync } from "child_process";
import * as p from "@clack/prompts";
import { PROMPT_FOR_MULTI } from "./prompts/promptForMulti.js";
import { PROMPT_FOR_SINGLE } from "./prompts/promptForSingle.js";

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
	.argument("[apiPath]", "변환할 API 엔드포인트 경로 (예: /api/v1/user/search)")
	.option("-s, --swagger <url>", "회사의 Swagger JSON URL 주소")
	.option("-p, --provider <string>", "사용할 LLM 공급자 (ollama, openai, gemini)", "ollama")
	.option("-m, --model <string>", "사용할 LLM 모델명 (예: qwen2.5-coder:7b, gpt-4o-mini 등)")
	.option("-k, --key <string>", "LLM API Key")
	.option("-b, --base-url <url>", "LLM API Base URL (커스텀 엔드포인트)")
	.option("-t, --type <string>", "강제 지정 타입 선택 (query 또는 mutation)")
	.option("-a, --all", "Swagger JSON의 모든 API 경로에 대해 코드를 생성합니다.")
	.action(async (apiPath: string | undefined, options) => {
		const isInteractive = !apiPath;

		let apiPathVal = apiPath;
		let providerVal = options.provider || process.env.LLM_PROVIDER || "ollama";
		let swaggerUrlVal = options.swagger || process.env.SWAGGER_URL;
		let forceTypeVal = options.type;
		let apiKeyVal = options.key;
		let baseURLVal = options.baseUrl;
		let modelVal = options.model;

		if (isInteractive) {
			p.intro(`✨ swagger-to-rq (gen-rq) CLI ✨`);

			const steps = [];
			if (!options.all) {
				steps.push("apiPath");
			}
			steps.push("swaggerUrl", "provider", "providerDetails", "forceType");
			let currentStepIndex = 0;

			while (currentStepIndex < steps.length) {
				const currentStep = steps[currentStepIndex];

				if (currentStep === "apiPath") {
					// 1. API Path 입력받기
					const pathInput = await p.text({
						message: "변환할 API 엔드포인트 경로를 입력하세요",
						placeholder: "/api/v1/user/search",
						initialValue: apiPathVal,
						validate(value) {
							if (!value) return "경로는 필수 입력 항목입니다.";
							if (value !== ".." && !value.startsWith("/")) return "경로는 '/'로 시작해야 합니다.";
						},
					});
					if (p.isCancel(pathInput)) {
						p.cancel("작업이 취소되었습니다.");
						return;
					}
					if (pathInput === "..") {
						p.log.warn("이전 단계가 없습니다.");
						continue;
					}
					apiPathVal = pathInput as string;
					currentStepIndex++;
				} else if (currentStep === "swaggerUrl") {
					// 2. Swagger URL 입력받기 (환경 변수 있으면 기본값으로 제시)
					const defaultSwagger = swaggerUrlVal || process.env.SWAGGER_URL || "";
					const swaggerInput = await p.text({
						message: "Swagger JSON URL 주소를 입력하세요 ('..' 입력 시 이전 단계로)",
						placeholder: "http://example.com/swagger.json",
						initialValue: defaultSwagger,
						validate(value) {
							if (!value) return "Swagger URL은 필수 입력 항목입니다.";
							if (value !== ".." && !value.startsWith("http://") && !value.startsWith("https://")) {
								return "올바른 URL 형식이어야 합니다. (http:// 또는 https://)";
							}
						},
					});
					if (p.isCancel(swaggerInput)) {
						p.cancel("작업이 취소되었습니다.");
						return;
					}
					if (swaggerInput === "..") {
						currentStepIndex--;
						continue;
					}
					swaggerUrlVal = swaggerInput as string;
					currentStepIndex++;
				} else if (currentStep === "provider") {
					// 3. LLM Provider 선택하기
					const providerInput = await p.select({
						message: "사용할 LLM 공급자(Provider)를 선택하세요",
						options: [
							{ value: "ollama", label: "Ollama (로컬 LLM - 무료 & 보안 안심)" },
							{ value: "openai", label: "OpenAI (GPT-4o-mini 등)" },
							{ value: "gemini", label: "Google Gemini (gemini-3.5-flash 등)" },
							{ value: "custom", label: "Custom (기타 OpenAI 호환 API)" },
							{ value: "back", label: "◀ 이전 단계로 돌아가기 (Swagger URL 입력으로)" },
						],
						initialValue: providerVal || "ollama",
					});
					if (p.isCancel(providerInput)) {
						p.cancel("작업이 취소되었습니다.");
						return;
					}
					if (providerInput === "back") {
						currentStepIndex--;
						continue;
					}
					providerVal = providerInput as string;
					currentStepIndex++;
				} else if (currentStep === "providerDetails") {
					// 4. Provider별 상세 옵션 (Model, API Key, Base URL)
					let detailsGoBack = false;

					if (providerVal === "ollama") {
						apiKeyVal = "ollama";

						const ollamaModelInput = await p.text({
							message: "사용할 Ollama 모델명을 입력하세요 ('..' 입력 시 이전 단계로)",
							placeholder: "qwen2.5-coder:7b",
							initialValue: modelVal || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b",
							validate(value) {
								if (!value) return "모델명은 필수 입력 항목입니다.";
							},
						});
						if (p.isCancel(ollamaModelInput)) {
							p.cancel("작업이 취소되었습니다.");
							return;
						}
						if (ollamaModelInput === "..") {
							detailsGoBack = true;
						} else {
							modelVal = ollamaModelInput as string;

							const ollamaBaseInput = await p.text({
								message: "Ollama Base URL 주소를 입력하세요 ('..' 입력 시 이전 단계로)",
								placeholder: "http://localhost:11434/v1",
								initialValue: baseURLVal || process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
								validate(value) {
									if (!value) return "Base URL은 필수 입력 항목입니다.";
								},
							});
							if (p.isCancel(ollamaBaseInput)) {
								p.cancel("작업이 취소되었습니다.");
								return;
							}
							if (ollamaBaseInput === "..") {
								continue;
							}
							baseURLVal = ollamaBaseInput as string;
						}
					} else if (providerVal === "openai") {
						const defaultKey = apiKeyVal || process.env.OPENAI_API_KEY || "";
						const keyInput = await p.text({
							message: "OpenAI API Key를 입력하세요 ('..' 입력 시 이전 단계로)",
							placeholder: "sk-...",
							initialValue: defaultKey,
							validate(value) {
								if (!value) return "API Key가 필요합니다.";
							},
						});
						if (p.isCancel(keyInput)) {
							p.cancel("작업이 취소되었습니다.");
							return;
						}
						if (keyInput === "..") {
							detailsGoBack = true;
						} else {
							apiKeyVal = keyInput as string;

							const openaiModelInput = await p.text({
								message: "사용할 OpenAI 모델명을 입력하세요 ('..' 입력 시 이전 단계로)",
								placeholder: "gpt-4o-mini",
								initialValue: modelVal || process.env.OPENAI_MODEL || "gpt-4o-mini",
								validate(value) {
									if (!value) return "모델명은 필수 입력 항목입니다.";
								},
							});
							if (p.isCancel(openaiModelInput)) {
								p.cancel("작업이 취소되었습니다.");
								return;
							}
							if (openaiModelInput === "..") {
								continue;
							}
							modelVal = openaiModelInput as string;
							baseURLVal = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
						}
					} else if (providerVal === "gemini") {
						const defaultKey = apiKeyVal || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "";
						const keyInput = await p.text({
							message: "Gemini API Key를 입력하세요 ('..' 입력 시 이전 단계로)",
							placeholder: "AIzaSy...",
							initialValue: defaultKey,
							validate(value) {
								if (!value) return "API Key가 필요합니다.";
							},
						});
						if (p.isCancel(keyInput)) {
							p.cancel("작업이 취소되었습니다.");
							return;
						}
						if (keyInput === "..") {
							detailsGoBack = true;
						} else {
							apiKeyVal = keyInput as string;

							const geminiModelInput = await p.text({
								message: "사용할 Gemini 모델명을 입력하세요 ('..' 입력 시 이전 단계로)",
								placeholder: "gemini-3.5-flash",
								initialValue: modelVal || process.env.GEMINI_MODEL || "gemini-3.5-flash",
								validate(value) {
									if (!value) return "모델명은 필수 입력 항목입니다.";
								},
							});
							if (p.isCancel(geminiModelInput)) {
								p.cancel("작업이 취소되었습니다.");
								return;
							}
							if (geminiModelInput === "..") {
								continue;
							}
							modelVal = geminiModelInput as string;
							baseURLVal = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/";
						}
					} else {
						// Custom Provider
						const customBaseInput = await p.text({
							message: "Custom LLM API Base URL을 입력하세요 ('..' 입력 시 이전 단계로)",
							placeholder: "https://api.deepseek.com/v1",
							initialValue: baseURLVal || process.env.LLM_BASE_URL || "",
							validate(value) {
								if (!value) return "Base URL은 필수 항목입니다.";
							},
						});
						if (p.isCancel(customBaseInput)) {
							p.cancel("작업이 취소되었습니다.");
							return;
						}
						if (customBaseInput === "..") {
							detailsGoBack = true;
						} else {
							baseURLVal = customBaseInput as string;

							const keyInput = await p.text({
								message: "API Key를 입력하세요 ('..' 입력 시 이전 단계로)",
								placeholder: "your-api-key",
								initialValue: apiKeyVal || process.env.LLM_API_KEY || "",
								validate(value) {
									if (!value) return "API Key가 필요합니다.";
								},
							});
							if (p.isCancel(keyInput)) {
								p.cancel("작업이 취소되었습니다.");
								return;
							}
							if (keyInput === "..") {
								continue;
							}
							apiKeyVal = keyInput as string;

							const customModelInput = await p.text({
								message: "사용할 모델명을 입력하세요 ('..' 입력 시 이전 단계로)",
								placeholder: "deepseek-chat",
								initialValue: modelVal || process.env.LLM_MODEL || "gpt-4o-mini",
								validate(value) {
									if (!value) return "모델명은 필수 입력 항목입니다.";
								},
							});
							if (p.isCancel(customModelInput)) {
								p.cancel("작업이 취소되었습니다.");
								return;
							}
							if (customModelInput === "..") {
								continue;
							}
							modelVal = customModelInput as string;
						}
					}

					if (detailsGoBack) {
						currentStepIndex--;
					} else {
						currentStepIndex++;
					}
				} else if (currentStep === "forceType") {
					// 5. Query / Mutation 타입 강제 설정 여부
					const typeInput = await p.select({
						message: "TanStack Query 훅 타입을 강제로 지정하시겠습니까?",
						options: [
							{ value: "auto", label: "자동 판별 (API 엔드포인트 명세 분석)" },
							{ value: "query", label: "useQuery 훅 강제 지정" },
							{ value: "mutation", label: "useMutation 훅 강제 지정" },
							{ value: "back", label: "◀ 이전 단계로 돌아가기 (공급자 상세 설정으로)" },
						],
						initialValue: forceTypeVal || "auto",
					});
					if (p.isCancel(typeInput)) {
						p.cancel("작업이 취소되었습니다.");
						return;
					}
					if (typeInput === "back") {
						currentStepIndex--;
						continue;
					}
					forceTypeVal = typeInput === "auto" ? undefined : (typeInput as string);
					currentStepIndex++;
				}
			}
		} else {
			// 명령어 모드 (기존 로직 동일)
			const provider = providerVal.toLowerCase();

			if (provider === "ollama") {
				apiKeyVal = apiKeyVal || "ollama";
				baseURLVal = baseURLVal || process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
				modelVal = modelVal || process.env.OLLAMA_MODEL || "qwen2.5-coder:7b";
			} else if (provider === "openai") {
				apiKeyVal = apiKeyVal || process.env.OPENAI_API_KEY;
				baseURLVal = baseURLVal || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
				modelVal = modelVal || process.env.OPENAI_MODEL || "gpt-4o-mini";
			} else if (provider === "gemini") {
				apiKeyVal = apiKeyVal || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
				baseURLVal = baseURLVal || process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/";
				modelVal = modelVal || process.env.GEMINI_MODEL || "gemini-3.5-flash";
			} else {
				apiKeyVal = apiKeyVal || process.env.LLM_API_KEY;
				baseURLVal = baseURLVal || process.env.LLM_BASE_URL;
				modelVal = modelVal || process.env.LLM_MODEL || "gpt-4o-mini";
			}

			// 수동 옵션 오타 검증
			if (forceTypeVal && forceTypeVal !== "query" && forceTypeVal !== "mutation") {
				console.error('❌ 에러: -t (--type) 옵션은 오직 "query" 또는 "mutation"만 입력 가능합니다.');
				return;
			}

			if (!apiKeyVal && providerVal !== "ollama") {
				console.error(`❌ 에러: ${providerVal.toUpperCase()} API Key가 없습니다. -k 옵션을 주거나 .env를 설정하세요.`);
				return;
			}

			if (!swaggerUrlVal) {
				console.error("❌ 에러: Swagger JSON URL 주소가 없습니다. -s 옵션을 주거나 .env에 SWAGGER_URL을 설정하세요.");
				return;
			}

			if (!options.all && !apiPathVal) {
				console.error("❌ 에러: 변환할 API 엔드포인트 경로가 입력되지 않았습니다. 또는 --all 옵션을 사용하세요.");
				return;
			}
		}

		// 공통 Swagger 파싱 및 AI 호출 로직
		try {
			let swaggerJson;
			if (isInteractive) {
				const s = p.spinner();
				s.start(`🌐 1. Swagger 명세 가져오는 중... (${swaggerUrlVal})`);
				try {
					const { data } = await axios.get(swaggerUrlVal!);
					swaggerJson = data;
					s.stop(`🌐 1. Swagger 명세 로드 완료!`);
				} catch (error: any) {
					s.stop(`❌ Swagger 명세 로드 실패!`);
					p.cancel(`에러 내용: ${error.message}`);
					return;
				}
			} else {
				console.log(`🌐 1. Swagger 명세 가져오는 중... (${swaggerUrlVal})`);
				const { data } = await axios.get(swaggerUrlVal!);
				swaggerJson = data;
			}

			const pathsToProcess = options.all ? Object.keys(swaggerJson.paths || {}) : [apiPathVal!];

			if (pathsToProcess.length === 0) {
				const errorMsg = `❌ 에러: 처리할 API 경로가 존재하지 않습니다.`;
				if (isInteractive) {
					p.cancel(errorMsg);
				} else {
					console.error(errorMsg);
				}
				return;
			}

			const callWithRetry = async (fn: () => Promise<any>, retries = 3, delay = 5000) => {
				for (let attempt = 1; attempt <= retries; attempt++) {
					try {
						return await fn();
					} catch (error: any) {
						if (error.status === 429 && attempt < retries) {
							const seconds = delay / 1000;
							if (isInteractive) {
								p.log.warn(
									`⚠️ [Rate Limit 429] 일시적으로 요청 한도에 도달했습니다. ${seconds}초 후 다시 시도합니다... (시도 ${attempt}/${retries})`,
								);
							} else {
								console.warn(
									`⚠️ [Rate Limit 429] 일시적으로 요청 한도에 도달했습니다. ${seconds}초 후 다시 시도합니다... (시도 ${attempt}/${retries})`,
								);
							}
							await new Promise((resolve) => setTimeout(resolve, delay));
							continue;
						}
						throw error;
					}
				}
			};

			const openai = new OpenAI({
				apiKey: apiKeyVal,
				baseURL: baseURLVal,
			});

			const systemPrompt = PROMPT_FOR_SINGLE;

			let successCount = 0;
			let failCount = 0;

			// 도메인 추출 헬퍼 함수
			const getDomainFromPath = (pathStr: string): string => {
				const segments = pathStr.split("/").filter(Boolean);
				const vIndex = segments.findIndex(seg => /^v\d+$/.test(seg));
				let domain = "common";
				if (vIndex !== -1 && segments[vIndex + 1]) {
					domain = segments[vIndex + 1];
				} else if (segments.length > 0) {
					domain = segments[0];
				}
				if (domain === "login") {
					domain = "auth";
				}
				return domain;
			};

			if (options.all) {
				// 도메인별 그룹핑
				const domainGroups: Record<string, string[]> = {};
				for (const p of pathsToProcess) {
					const domain = getDomainFromPath(p);
					if (!domainGroups[domain]) {
						domainGroups[domain] = [];
					}
					domainGroups[domain].push(p);
				}

				const domainList = Object.keys(domainGroups);

				// --all 옵션: 도메인별로 묶어 처리
				for (const domain of domainList) {
					const domainPaths = domainGroups[domain];
					
					// 도메인 내 경로들을 10개씩 청크 분할
					const chunkSize = 10;
					const chunks: string[][] = [];
					for (let i = 0; i < domainPaths.length; i += chunkSize) {
						chunks.push(domainPaths.slice(i, i + chunkSize));
					}

					for (let c = 0; c < chunks.length; c++) {
						const chunk = chunks[c];
						const chunkSpecs: Record<string, any> = {};
						for (const p of chunk) {
							chunkSpecs[p] = swaggerJson.paths?.[p];
						}

						const progressPrefix = `[도메인: ${domain}] [그룹 ${c + 1}/${chunks.length}]`;
						if (isInteractive) {
							p.log.step(`${progressPrefix} 🔍 API ${chunk.length}개 명세 분석 중...`);
						} else {
							console.log(`${progressPrefix} 🔍 API ${chunk.length}개 명세 분석 중...`);
						}

						// 기존 파일 로드 (병합용)
						const targetApisPath = path.join(process.cwd(), "src", "apis", `${domain}.ts`);
						const targetModelsPath = path.join(process.cwd(), "src", "models", `${domain}.ts`);

						let existingApisCode = "";
						let existingModelsCode = "";
						if (fs.existsSync(targetApisPath)) {
							existingApisCode = fs.readFileSync(targetApisPath, "utf8");
						}
						if (fs.existsSync(targetModelsPath)) {
							existingModelsCode = fs.readFileSync(targetModelsPath, "utf8");
						}

						const systemPromptForMulti = PROMPT_FOR_MULTI;

						const userPrompt = `
다음 복수의 Swagger API 명세들을 바탕으로 모델/타입 파일(models)과 API 요청 파일(apis)을 생성하거나 기존 파일에 추가해줘.
도메인 명칭은 '${domain}' 입니다.

${existingModelsCode ? `[기존 models/${domain}.ts 내용]\n이 타입들을 삭제하지 말고 그대로 유지하면서 새로운 API의 Payload/Response 타입들을 추가해줘:\n${existingModelsCode}\n` : ""}
${existingApisCode ? `[기존 apis/${domain}.ts 내용]\n이 기존 메소드들과 임포트문들을 삭제하지 말고 그대로 유지하며 새 API 메소드들을 추가해줘:\n${existingApisCode}\n` : ""}

[새로 생성/추가해야 할 Swagger API 명세]
${JSON.stringify(chunkSpecs, null, 2)}
`;

						let generatedCode;
						const makeRequest = () =>
							openai.chat.completions.create({
								model: modelVal!,
								messages: [
									{ role: "system", content: systemPromptForMulti },
									{ role: "user", content: userPrompt },
								],
								temperature: 0.1,
							});

						if (isInteractive) {
							const s = p.spinner();
							s.start(`🤖 AI 엔진을 통해 일괄 코드 생성 중... (${providerVal} - ${modelVal})`);
							try {
								const response = await callWithRetry(makeRequest);
								generatedCode = response.choices[0].message?.content;
								s.stop(`🤖 AI 코드 일괄 생성 완료!`);
							} catch (error: any) {
								s.stop(`❌ AI 코드 일괄 생성 실패!`);
								p.log.error(`에러 내용: ${error.message}`);
								failCount += chunk.length;
								continue;
							}
						} else {
							console.log(`🤖 AI 엔진을 통해 일괄 코드 생성 중... (${providerVal} - ${modelVal})`);
							try {
								const response = await callWithRetry(makeRequest);
								generatedCode = response.choices[0].message?.content;
							} catch (error: any) {
								console.error(`❌ AI 코드 일괄 생성 실패! 에러 내용: ${error.message}`);
								failCount += chunk.length;
								continue;
							}
						}

						if (!generatedCode) {
							const errorMsg = "❌ 에러: AI가 코드를 생성하는 데 실패했습니다.";
							if (isInteractive) {
								p.log.error(errorMsg);
							} else {
								console.error(errorMsg);
							}
							failCount += chunk.length;
							continue;
						}

						// 파일별 파싱 및 쓰기
						const fileRegex = /--- FILE_START:\s*(models\/[\w\-]+\.ts|apis\/[\w\-]+\.ts)\s*---\r?\n([\s\S]*?)--- FILE_END ---/g;
						let match;
						let extractedCount = 0;
						
						const apisDir = path.join(process.cwd(), "src", "apis");
						const modelsDir = path.join(process.cwd(), "src", "models");
						if (!fs.existsSync(apisDir)) fs.mkdirSync(apisDir, { recursive: true });
						if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

						while ((match = fileRegex.exec(generatedCode)) !== null) {
							const relativePath = match[1].trim(); // e.g. "models/settlement.ts" or "apis/settlement.ts"
							const fileCode = match[2]
								.replace(/```typescript/g, "")
								.replace(/```/g, "")
								.trim();

							const fullPath = path.join(process.cwd(), "src", relativePath);
							fs.writeFileSync(fullPath, fileCode, "utf8");
							successCount++;
							extractedCount++;

							if (isInteractive) {
								p.log.success(`✨ 파일 생성/업데이트 성공: ${relativePath}`);
							} else {
								console.log(`✨ 파일 생성/업데이트 성공: ${relativePath}`);
							}
						}

						if (extractedCount === 0) {
							failCount += chunk.length;
							if (isInteractive) {
								p.log.warn(`⚠️ 생성된 마커 포맷을 파싱할 수 없습니다. 출력 코드를 다시 확인하세요.`);
							} else {
								console.warn(`⚠️ 생성된 마커 포맷을 파싱할 수 없습니다. 출력 코드를 다시 확인하세요.`);
							}
						}

						if (c < chunks.length - 1 || domain !== domainList[domainList.length - 1]) {
							// 연속적인 AI 그룹 호출을 방지하기 위한 안전 대기 딜레이
							await new Promise((resolve) => setTimeout(resolve, 2000));
						}
					}
				}
			} else {
				// 단일 API 처리 모드
				const currentPath = pathsToProcess[0];
				const domain = getDomainFromPath(currentPath);

				if (isInteractive) {
					p.log.step(`🔍 API 경로 [${currentPath}] 탐색 및 명세 추출 중...`);
				} else {
					console.log(`🔍 API 경로 [${currentPath}] 탐색 및 명세 추출 중...`);
				}

				const pathSpecs = swaggerJson.paths?.[currentPath];

				if (!pathSpecs) {
					const errorMsg = `❌ 에러: Swagger에서 [${currentPath}] 경로를 찾을 수 없습니다.`;
					if (isInteractive) {
						p.cancel(errorMsg);
					} else {
						console.error(errorMsg);
					}
					return;
				}

				const targetedSpec = JSON.stringify(
					{
						path: currentPath,
						specs: pathSpecs,
					},
					null,
					2,
				);

				const targetApisPath = path.join(process.cwd(), "src", "apis", `${domain}.ts`);
				const targetModelsPath = path.join(process.cwd(), "src", "models", `${domain}.ts`);

				let existingApisCode = "";
				let existingModelsCode = "";
				if (fs.existsSync(targetApisPath)) {
					existingApisCode = fs.readFileSync(targetApisPath, "utf8");
				}
				if (fs.existsSync(targetModelsPath)) {
					existingModelsCode = fs.readFileSync(targetModelsPath, "utf8");
				}

				const userPrompt = `
다음 Swagger API 명세를 바탕으로 모델/타입 파일(models)과 API 요청 파일(apis)을 생성하거나 기존 파일에 추가해줘.
도메인 명칭은 '${domain}' 입니다.

${existingModelsCode ? `[기존 models/${domain}.ts 내용]\n이 타입들을 삭제하지 말고 그대로 유지하면서 새로운 API의 Payload/Response 타입들을 추가해줘:\n${existingModelsCode}\n` : ""}
${existingApisCode ? `[기존 apis/${domain}.ts 내용]\n이 기존 메소드들과 임포트문들을 삭제하지 말고 그대로 유지하며 새 API 메소드들을 추가해줘:\n${existingApisCode}\n` : ""}

[새로 생성/추가해야 할 Swagger API 명세]
${targetedSpec}
`;

				let generatedCode;
				const makeRequest = () =>
					openai.chat.completions.create({
						model: modelVal!,
						messages: [
							{ role: "system", content: systemPrompt },
							{ role: "user", content: userPrompt },
						],
						temperature: 0.1,
					});

				if (isInteractive) {
					const s = p.spinner();
					s.start(`🤖 AI 엔진을 통해 TypeScript 코드 생성 중... (${providerVal} - ${modelVal})`);
					try {
						const response = await callWithRetry(makeRequest);
						generatedCode = response.choices[0].message?.content;
						s.stop(`🤖 AI 코드 생성 완료!`);
					} catch (error: any) {
						s.stop(`❌ AI 코드 생성 실패!`);
						p.log.error(`에러 내용: ${error.message}`);
						return;
					}
				} else {
					console.log(`🤖 AI 엔진을 통해 TypeScript 코드 생성 중... (${providerVal} - ${modelVal})`);
					try {
						const response = await callWithRetry(makeRequest);
						generatedCode = response.choices[0].message?.content;
					} catch (error: any) {
						console.error(`❌ AI 코드 생성 실패! 에러 내용: ${error.message}`);
						return;
					}
				}

				if (!generatedCode) {
					const errorMsg = "❌ 에러: AI가 코드를 생성하는 데 실패했습니다.";
					if (isInteractive) {
						p.cancel(errorMsg);
					} else {
						console.error(errorMsg);
					}
					return;
				}

				// 파일별 파싱 및 쓰기
				const fileRegex = /--- FILE_START:\s*(models\/[\w\-]+\.ts|apis\/[\w\-]+\.ts)\s*---\r?\n([\s\S]*?)--- FILE_END ---/g;
				let match;
				let extractedCount = 0;

				const apisDir = path.join(process.cwd(), "src", "apis");
				const modelsDir = path.join(process.cwd(), "src", "models");
				if (!fs.existsSync(apisDir)) fs.mkdirSync(apisDir, { recursive: true });
				if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

				while ((match = fileRegex.exec(generatedCode)) !== null) {
					const relativePath = match[1].trim(); // e.g. "models/settlement.ts" or "apis/settlement.ts"
					const fileCode = match[2]
						.replace(/```typescript/g, "")
						.replace(/```/g, "")
						.trim();

					const fullPath = path.join(process.cwd(), "src", relativePath);
					fs.writeFileSync(fullPath, fileCode, "utf8");
					extractedCount++;

					if (isInteractive) {
						p.log.success(`✨ 파일 저장 성공: src/${relativePath}`);
					} else {
						console.log(`✨ 파일 저장 성공: src/${relativePath}`);
					}
				}

				if (extractedCount === 0) {
					const errorMsg = "❌ 에러: AI 답변에서 파일 구분 마커를 파싱하지 못했습니다.";
					if (isInteractive) {
						p.cancel(errorMsg);
					} else {
						console.error(errorMsg);
					}
					return;
				}

				if (isInteractive) {
					p.outro(`🎉 모든 작업이 성공적으로 완료되었습니다!`);
				}
			}

			// 요약 출력
			if (options.all) {
				const summaryMsg = `🎉 전체 작업 완료! (성공: ${successCount}개, 실패: ${failCount}개)`;
				if (isInteractive) {
					p.outro(summaryMsg);
				} else {
					console.log(`\n${summaryMsg}`);
				}
			} else {
				if (isInteractive) {
					p.outro(`🎉 모든 작업이 성공적으로 완료되었습니다!`);
				} else {
					console.log(`\n🎉 모든 작업이 성공적으로 완료되었습니다!`);
				}
			}
		} catch (error: any) {
			if (isInteractive) {
				p.cancel(`❌ 실행 중 치명적인 오류가 발생했습니다: ${error.message}`);
			} else {
				console.error("\n❌ 실행 중 치명적인 오류가 발생했습니다.");
			}

			if (providerVal === "ollama" && (error.code === "ECONNREFUSED" || error.message?.includes("fetch"))) {
				console.error("💡 [Ollama 연결 실패] 로컬 Ollama 엔진이 실행 중인지 확인하세요!");
				console.error("   1. Ollama 앱이 켜져 있는지 확인 (트레이 아이콘)");
				console.error("   2. 터미널에 'ollama run qwen2.5-coder:7b' 가 정상 구동 중인지 확인");
			} else if (!isInteractive) {
				console.error(`📝 에러 내용: ${error.message}`);
			}
		}
	});

program.parse(process.argv);
