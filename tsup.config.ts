import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"], // 진입점 파일
	format: ["esm"], // 최신 ESM 표준 포맷으로 빌드
	clean: true, // 빌드할 때마다 기존 dist 폴더 청소
	dts: true, // TypeScript 사용자를 위한 타입 정의 파일(.d.ts) 자동 생성
	minify: true, // 코드 압축으로 패키지 용량 최적화
});
