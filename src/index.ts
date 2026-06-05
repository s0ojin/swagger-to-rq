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

// 1. 기존 타입 파일에서 타입/인터페이스 이름 목록을 추출하는 헬퍼 함수
function getTypeNamesFromCode(code: string): string[] {
	if (!code) return [];
	const names: string[] = [];
	const interfaceRegex = /export\s+interface\s+(\w+)\b/g;
	const typeRegex = /export\s+type\s+(\w+)\b/g;
	let match;
	while ((match = interfaceRegex.exec(code)) !== null) {
		names.push(match[1]);
	}
	while ((match = typeRegex.exec(code)) !== null) {
		names.push(match[1]);
	}
	return Array.from(new Set(names));
}

// 2. 특정 선언(interface, type, const 등)을 중괄호 쌍을 완벽히 매칭하여 제거해주는 헬퍼
function removeDeclaration(body: string, keyword: string, name: string): string {
	const regex = new RegExp(`export\\s+(?:async\\s+)?${keyword}\\s+${name}\\b`);
	const match = body.match(regex);
	if (!match) return body;

	const startIndex = match.index!;
	let openBraces = 0;
	let endIndex = -1;
	let hasBracedStarted = false;

	for (let i = startIndex; i < body.length; i++) {
		if (body[i] === "{") {
			openBraces++;
			hasBracedStarted = true;
		} else if (body[i] === "}") {
			openBraces--;
			if (hasBracedStarted && openBraces === 0) {
				endIndex = i + 1;
				break;
			}
		}
		// 중괄호 없이 한 줄로 정의된 타입/상수 대응 (예: type A = string;)
		if (!hasBracedStarted && body[i] === ";" && openBraces === 0) {
			endIndex = i + 1;
			break;
		}
	}

	if (endIndex !== -1) {
		return body.substring(0, startIndex) + body.substring(endIndex);
	}
	return body;
}

// 3. Import 구문을 추출하고 본문과 분리하는 함수
function extractImports(code: string): { imports: { path: string; members: string[]; isType: boolean }[]; body: string } {
	const importRegex = /import\s+([\s\S]*?)\s+from\s+['"](.*?)['"];?/g;
	const imports: { path: string; members: string[]; isType: boolean }[] = [];
	let body = code;

	let match;
	const matches: string[] = [];
	while ((match = importRegex.exec(code)) !== null) {
		matches.push(match[0]);
		const importClause = match[1].trim();
		const importPath = match[2].trim();

		const isType = importClause.startsWith("type") || code.substring(match.index, match.index + match[0].length).includes("import type");

		// { A, B } 형태 파싱
		const memberMatch = importClause.match(/\{([\s\S]*?)\}/);
		if (memberMatch) {
			const members = memberMatch[1].split(",").map(m => m.trim()).filter(Boolean);
			imports.push({ path: importPath, members, isType });
		}
	}

	for (const m of matches) {
		body = body.replace(m, "");
	}

	return { imports, body: body.trim() };
}

// 4. 모아진 Import 정보들을 중복 제거 및 경로별 정렬하여 한 줄씩 생성
function mergeImports(
	existingImports: { path: string; members: string[]; isType: boolean }[],
	newImports: { path: string; members: string[]; isType: boolean }[]
): string {
	const merged: Record<string, { typeMembers: Set<string>; valueMembers: Set<string> }> = {};

	const addImport = (imp: { path: string; members: string[]; isType: boolean }) => {
		if (!merged[imp.path]) {
			merged[imp.path] = { typeMembers: new Set(), valueMembers: new Set() };
		}
		imp.members.forEach(m => {
			if (imp.isType) {
				merged[imp.path].typeMembers.add(m);
			} else {
				merged[imp.path].valueMembers.add(m);
			}
		});
	};

	existingImports.forEach(addImport);
	newImports.forEach(addImport);

	const lines: string[] = [];
	for (const [pathStr, data] of Object.entries(merged)) {
		if (data.typeMembers.size > 0) {
			const sortedMembers = Array.from(data.typeMembers).sort();
			lines.push(`import type { ${sortedMembers.join(", ")} } from '${pathStr}';`);
		}
		if (data.valueMembers.size > 0) {
			const sortedMembers = Array.from(data.valueMembers).sort();
			lines.push(`import { ${sortedMembers.join(", ")} } from '${pathStr}';`);
		}
	}

	return lines.join("\n");
}

// 5. 최종 스마트 병합 API
function mergeTypeScriptCode(existingCode: string, newCode: string): string {
	if (!existingCode) return newCode;
	if (!newCode) return existingCode;

	const existingParsed = extractImports(existingCode);
	const newParsed = extractImports(newCode);

	const mergedImportsStr = mergeImports(existingParsed.imports, newParsed.imports);

	let mergedBody = existingParsed.body;

	const interfaceRegex = /export\s+interface\s+(\w+)\b/g;
	let match;
	while ((match = interfaceRegex.exec(newParsed.body)) !== null) {
		mergedBody = removeDeclaration(mergedBody, "interface", match[1]);
	}

	const typeRegex = /export\s+type\s+(\w+)\b/g;
	while ((match = typeRegex.exec(newParsed.body)) !== null) {
		mergedBody = removeDeclaration(mergedBody, "type", match[1]);
	}

	const constRegex = /export\s+const\s+(\w+)\b/g;
	while ((match = constRegex.exec(newParsed.body)) !== null) {
		mergedBody = removeDeclaration(mergedBody, "const", match[1]);
	}

	return `${mergedImportsStr}\n\n${mergedBody.trim()}\n\n${newParsed.body.trim()}`;
}

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

			// LLM 공급자별 스마트 딜레이 정책 수립 (무료 제미나이 RPM 극복 목적)
			let domainDelayMs = 2000;
			let retryDelayMs = 5000;

			const provider = providerVal.toLowerCase();
			if (provider === "ollama") {
				domainDelayMs = 100; // 로컬 Ollama는 속도 최우선
				retryDelayMs = 1000;
			} else if (provider === "gemini") {
				domainDelayMs = 6000; // Gemini 무료 티어 15 RPM 극복을 위해 6초 대기
				retryDelayMs = 15000; // 429/503 발생 시 15초 대기 후 리셋 유도
			} else {
				domainDelayMs = 1500; // OpenAI 및 기타 유료 API 기본 지연
				retryDelayMs = 5000;
			}

			const callWithRetry = async (fn: () => Promise<any>, retries = 3, delay = retryDelayMs) => {
				for (let attempt = 1; attempt <= retries; attempt++) {
					try {
						return await fn();
					} catch (error: any) {
						const isRetryable = (error.status === 429 || error.status === 503) && attempt < retries;
						if (isRetryable) {
							const seconds = delay / 1000;
							const statusMsg = `Rate Limit ${error.status}`;
							if (isInteractive) {
								p.log.warn(
									`⚠️ [${statusMsg}] 일시적으로 요청 한도에 도달했습니다. ${seconds}초 후 다시 시도합니다... (시도 ${attempt}/${retries})`,
								);
							} else {
								console.warn(
									`⚠️ [${statusMsg}] 일시적으로 요청 한도에 도달했습니다. ${seconds}초 후 다시 시도합니다... (시도 ${attempt}/${retries})`,
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

				// --all 옵션: 각 도메인 전체를 단 한 번의 AI 호출로 생성 (속도 극대화, 누적 토큰 폭발 원천 차단)
				for (const domain of domainList) {
					const domainPaths = domainGroups[domain];
					const domainSpecs: Record<string, any> = {};
					for (const p of domainPaths) {
						domainSpecs[p] = swaggerJson.paths?.[p];
					}

					const progressPrefix = `[도메인: ${domain}]`;
					if (isInteractive) {
						p.log.step(`${progressPrefix} 🔍 API ${domainPaths.length}개 명세 분석 중...`);
					} else {
						console.log(`${progressPrefix} 🔍 API ${domainPaths.length}개 명세 분석 중...`);
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

					const existingTypeNames = getTypeNamesFromCode(existingModelsCode);

					const userPrompt = `
다음 복수의 Swagger API 명세들을 바탕으로 모델/타입 파일(models)과 API 요청 파일(apis)에 추가될 개별 TypeScript 타입 및 함수 조각들을 생성해줘.
도메인 명칭은 '${domain}' 입니다.

${existingTypeNames.length > 0 ? `[주의: 이미 정의된 타입 목록 (이 이름들과 절대 중복되지 않게 신규 타입을 정의하거나 재사용하세요)]\n${existingTypeNames.join(", ")}\n` : ""}

[새로 생성해야 할 Swagger API 명세]
${JSON.stringify(domainSpecs, null, 2)}
`;

					let generatedCode;
					const makeRequest = () => {
						const params: any = {
							model: modelVal!,
							messages: [
								{ role: "system", content: systemPromptForMulti },
								{ role: "user", content: userPrompt },
							],
							temperature: 0.1,
						};
						if (providerVal !== "ollama") {
							params.response_format = { type: "json_object" };
						}
						return openai.chat.completions.create(params);
					};

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
							failCount += domainPaths.length;
							continue;
						}
					} else {
						console.log(`🤖 AI 엔진을 통해 일괄 코드 생성 중... (${providerVal} - ${modelVal})`);
						try {
							const response = await callWithRetry(makeRequest);
							generatedCode = response.choices[0].message?.content;
						} catch (error: any) {
							console.error(`❌ AI 코드 일괄 생성 실패! 에러 내용: ${error.message}`);
							failCount += domainPaths.length;
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
						failCount += domainPaths.length;
						continue;
					}

					// JSON 파싱 및 파일 쓰기 (스마트 머지 엔진 연동)
					let result: any = {};
					try {
						const rawContent = generatedCode.trim();
						const jsonContent = rawContent.startsWith("```json")
							? rawContent.substring(7, rawContent.length - 3).trim()
							: rawContent.startsWith("```")
							? rawContent.substring(3, rawContent.length - 3).trim()
							: rawContent;
							
						result = JSON.parse(jsonContent);
					} catch (e: any) {
						const errorMsg = `❌ 에러: AI의 응답을 JSON 객체로 파싱하지 못했습니다.`;
						if (isInteractive) {
							p.log.error(errorMsg);
						} else {
							console.error(errorMsg);
						}
						failCount += domainPaths.length;
						continue;
					}

					const apisDir = path.join(process.cwd(), "src", "apis");
					const modelsDir = path.join(process.cwd(), "src", "models");
					if (!fs.existsSync(apisDir)) fs.mkdirSync(apisDir, { recursive: true });
					if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

					let extractedCount = 0;

					if (result.models) {
						const modelsPath = path.join(modelsDir, `${domain}.ts`);
						const cleanModels = result.models
							.replace(/```typescript/g, "")
							.replace(/```/g, "")
							.trim();
						const finalModelsCode = mergeTypeScriptCode(existingModelsCode, cleanModels);
						fs.writeFileSync(modelsPath, finalModelsCode, "utf8");
						extractedCount++;
						successCount++;
						if (isInteractive) {
							p.log.success(`✨ 파일 저장 성공: src/models/${domain}.ts`);
						} else {
							console.log(`✨ 파일 저장 성공: src/models/${domain}.ts`);
						}
					}
					if (result.apis) {
						const apisPath = path.join(apisDir, `${domain}.ts`);
						const cleanApis = result.apis
							.replace(/```typescript/g, "")
							.replace(/```/g, "")
							.trim();
						const finalApisCode = mergeTypeScriptCode(existingApisCode, cleanApis);
						fs.writeFileSync(apisPath, finalApisCode, "utf8");
						extractedCount++;
						successCount++;
						if (isInteractive) {
							p.log.success(`✨ 파일 저장 성공: src/apis/${domain}.ts`);
						} else {
							console.log(`✨ 파일 저장 성공: src/apis/${domain}.ts`);
						}
					}

					if (extractedCount === 0) {
						failCount += domainPaths.length;
						if (isInteractive) {
							p.log.warn(`⚠️ 생성된 JSON 포맷을 파싱할 수 없습니다. 출력 코드를 다시 확인하세요.`);
						} else {
							console.warn(`⚠️ 생성된 JSON 포맷을 파싱할 수 없습니다. 출력 코드를 다시 확인하세요.`);
						}
					}

					if (domain !== domainList[domainList.length - 1]) {
						// 연속적인 AI 그룹 호출을 방지하기 위한 안전 대기 딜레이 (LLM 공급자별 스마트 정책 적용)
						await new Promise((resolve) => setTimeout(resolve, domainDelayMs));
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

				const existingTypeNames = getTypeNamesFromCode(existingModelsCode);

				const userPrompt = `
다음 Swagger API 명세를 바탕으로 모델/타입 파일(models)과 API 요청 파일(apis)에 추가될 개별 TypeScript 타입 및 함수 조각들을 생성해줘.
도메인 명칭은 '${domain}' 입니다.

${existingTypeNames.length > 0 ? `[주의: 이미 정의된 타입 목록 (이 이름들과 절대 중복되지 않게 신규 타입을 정의하거나 재사용하세요)]\n${existingTypeNames.join(", ")}\n` : ""}

[새로 생성해야 할 Swagger API 명세]
${targetedSpec}
`;

				let generatedCode;
				const makeRequest = () => {
					const params: any = {
						model: modelVal!,
						messages: [
							{ role: "system", content: systemPrompt },
							{ role: "user", content: userPrompt },
						],
						temperature: 0.1,
					};
					if (providerVal !== "ollama") {
						params.response_format = { type: "json_object" };
					}
					return openai.chat.completions.create(params);
				};

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

				// JSON 파싱 및 파일 쓰기 (스마트 머지 엔진 연동)
				let result: any = {};
				try {
					const rawContent = generatedCode.trim();
					const jsonContent = rawContent.startsWith("```json")
						? rawContent.substring(7, rawContent.length - 3).trim()
						: rawContent.startsWith("```")
						? rawContent.substring(3, rawContent.length - 3).trim()
						: rawContent;
						
					result = JSON.parse(jsonContent);
				} catch (e: any) {
					const errorMsg = "❌ 에러: AI 답변을 JSON 객체로 파싱하지 못했습니다.";
					if (isInteractive) {
						p.cancel(errorMsg);
					} else {
						console.error(errorMsg);
					}
					return;
				}

				const apisDir = path.join(process.cwd(), "src", "apis");
				const modelsDir = path.join(process.cwd(), "src", "models");
				if (!fs.existsSync(apisDir)) fs.mkdirSync(apisDir, { recursive: true });
				if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });

				let extractedCount = 0;

				if (result.models) {
					const modelsPath = path.join(modelsDir, `${domain}.ts`);
					const cleanModels = result.models
						.replace(/```typescript/g, "")
						.replace(/```/g, "")
						.trim();
					const finalModelsCode = mergeTypeScriptCode(existingModelsCode, cleanModels);
					fs.writeFileSync(modelsPath, finalModelsCode, "utf8");
					extractedCount++;
					if (isInteractive) {
						p.log.success(`✨ 파일 저장 성공: src/models/${domain}.ts`);
					} else {
						console.log(`✨ 파일 저장 성공: src/models/${domain}.ts`);
					}
				}
				if (result.apis) {
					const apisPath = path.join(apisDir, `${domain}.ts`);
					const cleanApis = result.apis
						.replace(/```typescript/g, "")
						.replace(/```/g, "")
						.trim();
					const finalApisCode = mergeTypeScriptCode(existingApisCode, cleanApis);
					fs.writeFileSync(apisPath, finalApisCode, "utf8");
					extractedCount++;
					if (isInteractive) {
						p.log.success(`✨ 파일 저장 성공: src/apis/${domain}.ts`);
					} else {
						console.log(`✨ 파일 저장 성공: src/apis/${domain}.ts`);
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
