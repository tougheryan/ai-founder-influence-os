AIFIOS_HOME ?= $(CURDIR)
ECHO_FOUNDER_VERSION ?= $(shell tr -d '[:space:]' < $(AIFIOS_HOME)/VERSION)
DESKTOP_APP_NAME ?= Echo Founder
PROJECT ?= $(HOME)/ai-content-system
INSTALL_DIR ?= $(HOME)/.agents/skills
INSTALL_MODE ?= symlink
DEMO_PROJECT ?= /private/tmp/aifios-demo
DIST_DIR ?= dist
DESKTOP_SMOKE_PROJECT ?= /private/tmp/aifios-desktop-smoke
DESKTOP_SMOKE_TIMEOUT ?= 180
DESKTOP_SOAK_PROJECT ?= /private/tmp/aifios-desktop-soak
DESKTOP_SOAK_DURATION ?= 1800
DESKTOP_SOAK_INTERVAL ?= 30
DESKTOP_SOAK_STARTUP_TIMEOUT ?= 180
DESKTOP_PACKAGE_DIST ?= dist/desktop
DESKTOP_PACKAGE_APP ?= $(DESKTOP_PACKAGE_DIST)/$(DESKTOP_APP_NAME).app
DESKTOP_PACKAGE_MANIFEST ?= $(DESKTOP_PACKAGE_DIST)/desktop-package-manifest.json
DESKTOP_PACKAGE_ARCH ?= arm64
DESKTOP_RELEASE_BASELINE_SHA ?= $(shell git log --format=%H --grep='^chore: checkpoint commercial readiness baseline$$' -1 2>/dev/null)
DESKTOP_HOSTED_GATEWAY_URL ?=
DESKTOP_HOSTED_RESEARCH_PUBLIC_KEY ?=
DESKTOP_HOSTED_RESEARCH_KEY_ID ?= market-v1
DESKTOP_ELECTRON_ARM64_ARCHIVE ?=
DESKTOP_ELECTRON_ARM64_SHA256 ?=
DESKTOP_ELECTRON_X64_ARCHIVE ?=
DESKTOP_ELECTRON_X64_SHA256 ?=
DESKTOP_PLAYWRIGHT_ARM64_ARCHIVE ?=
DESKTOP_PLAYWRIGHT_ARM64_SHA256 ?=
DESKTOP_PLAYWRIGHT_X64_ARCHIVE ?=
DESKTOP_PLAYWRIGHT_X64_SHA256 ?=
DESKTOP_EMBED_PYTHON_RUNTIME ?= required
DESKTOP_PYTHON_VERSION ?= 3.11.15
DESKTOP_PYTHON_RUNTIME_ARCHIVE ?=
DESKTOP_PYTHON_RUNTIME_SHA256 ?=
DESKTOP_PYTHON_RUNTIME_ARM64_ARCHIVE ?=
DESKTOP_PYTHON_RUNTIME_ARM64_SHA256 ?=
DESKTOP_PYTHON_RUNTIME_X64_ARCHIVE ?=
DESKTOP_PYTHON_RUNTIME_X64_SHA256 ?=
DESKTOP_SOCIAL_MEDIA_CRAWL_DIR ?=
DESKTOP_SUPPLY_CHAIN_ARCHIVE_ARGS = $(if $(DESKTOP_PYTHON_RUNTIME_ARCHIVE),--python-runtime-archive "$(DESKTOP_PYTHON_RUNTIME_ARCHIVE)") $(if $(DESKTOP_PYTHON_RUNTIME_SHA256),--python-runtime-sha256 "$(DESKTOP_PYTHON_RUNTIME_SHA256)") $(if $(DESKTOP_PYTHON_RUNTIME_ARM64_ARCHIVE),--python-runtime-arm64-archive "$(DESKTOP_PYTHON_RUNTIME_ARM64_ARCHIVE)") $(if $(DESKTOP_PYTHON_RUNTIME_ARM64_SHA256),--python-runtime-arm64-sha256 "$(DESKTOP_PYTHON_RUNTIME_ARM64_SHA256)") $(if $(DESKTOP_PYTHON_RUNTIME_X64_ARCHIVE),--python-runtime-x64-archive "$(DESKTOP_PYTHON_RUNTIME_X64_ARCHIVE)") $(if $(DESKTOP_PYTHON_RUNTIME_X64_SHA256),--python-runtime-x64-sha256 "$(DESKTOP_PYTHON_RUNTIME_X64_SHA256)") $(if $(DESKTOP_ELECTRON_ARM64_ARCHIVE),--electron-arm64-archive "$(DESKTOP_ELECTRON_ARM64_ARCHIVE)") $(if $(DESKTOP_ELECTRON_ARM64_SHA256),--electron-arm64-sha256 "$(DESKTOP_ELECTRON_ARM64_SHA256)") $(if $(DESKTOP_ELECTRON_X64_ARCHIVE),--electron-x64-archive "$(DESKTOP_ELECTRON_X64_ARCHIVE)") $(if $(DESKTOP_ELECTRON_X64_SHA256),--electron-x64-sha256 "$(DESKTOP_ELECTRON_X64_SHA256)") $(if $(DESKTOP_PLAYWRIGHT_ARM64_ARCHIVE),--playwright-arm64-archive "$(DESKTOP_PLAYWRIGHT_ARM64_ARCHIVE)") $(if $(DESKTOP_PLAYWRIGHT_ARM64_SHA256),--playwright-arm64-sha256 "$(DESKTOP_PLAYWRIGHT_ARM64_SHA256)") $(if $(DESKTOP_PLAYWRIGHT_X64_ARCHIVE),--playwright-x64-archive "$(DESKTOP_PLAYWRIGHT_X64_ARCHIVE)") $(if $(DESKTOP_PLAYWRIGHT_X64_SHA256),--playwright-x64-sha256 "$(DESKTOP_PLAYWRIGHT_X64_SHA256)")
DESKTOP_PACKAGE_PROJECT ?= /private/tmp/aifios-packaged-smoke
DESKTOP_PACKAGE_USER_DATA_DIR ?= /private/tmp/aifios-packaged-user-data
DESKTOP_PACKAGE_TIMEOUT ?= 120
DESKTOP_PACKAGED_MINIMAL_ENV ?= 1
DESKTOP_PACKAGED_EXPECTED_ARCH ?= $(DESKTOP_PACKAGE_ARCH)
DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE ?= bundled-runtime
DESKTOP_PACKAGED_X64_PROJECT ?= /private/tmp/aifios-packaged-x64-smoke
DESKTOP_PACKAGED_X64_USER_DATA_DIR ?= /private/tmp/aifios-packaged-x64-user-data
DESKTOP_PACKAGED_X64_TIMEOUT ?= 180
DESKTOP_PACKAGED_X64_EXPECTED_ARCH ?= x64
DESKTOP_PACKAGED_OPEN_PROJECT ?= /private/tmp/aifios-packaged-open-smoke
DESKTOP_PACKAGED_OPEN_USER_DATA_DIR ?= /private/tmp/aifios-packaged-open-user-data
DESKTOP_PACKAGED_OPEN_TIMEOUT ?= 120
DESKTOP_PACKAGED_OPEN_REPORT_DIR ?= quality/system-audits
DESKTOP_PACKAGED_SINGLE_INSTANCE_PROJECT ?= /private/tmp/aifios-packaged-single-instance-smoke
DESKTOP_PACKAGED_SINGLE_INSTANCE_USER_DATA_DIR ?= /private/tmp/aifios-packaged-single-instance-user-data
DESKTOP_PACKAGED_SINGLE_INSTANCE_TIMEOUT ?= 120
DESKTOP_PACKAGED_SINGLE_INSTANCE_DUPLICATE_TIMEOUT ?= 20
DESKTOP_PACKAGED_SINGLE_INSTANCE_REPORT_DIR ?= quality/system-audits
DESKTOP_PACKAGED_RECOVERY_PROJECT ?= /private/tmp/aifios-packaged-recovery-smoke
DESKTOP_PACKAGED_RECOVERY_USER_DATA_DIR ?= /private/tmp/aifios-packaged-recovery-user-data
DESKTOP_PACKAGED_RECOVERY_TIMEOUT ?= 120
DESKTOP_PACKAGED_RECOVERY_RESTART_TIMEOUT ?= 60
DESKTOP_PACKAGED_RECOVERY_REPORT_DIR ?= quality/system-audits
DESKTOP_PACKAGED_WATCHDOG_PROJECT ?= /private/tmp/aifios-packaged-watchdog-smoke
DESKTOP_PACKAGED_WATCHDOG_USER_DATA_DIR ?= /private/tmp/aifios-packaged-watchdog-user-data
DESKTOP_PACKAGED_WATCHDOG_TIMEOUT ?= 120
DESKTOP_PACKAGED_WATCHDOG_RESTART_TIMEOUT ?= 60
DESKTOP_PACKAGED_WATCHDOG_REPORT_DIR ?= quality/system-audits
DESKTOP_PACKAGED_SOAK_PROJECT ?= /private/tmp/aifios-packaged-soak
DESKTOP_PACKAGED_SOAK_USER_DATA_DIR ?= /private/tmp/aifios-packaged-soak-user-data
DESKTOP_PACKAGED_SOAK_DURATION ?= 1800
DESKTOP_PACKAGED_SOAK_INTERVAL ?= 30
DESKTOP_PACKAGED_SOAK_STARTUP_TIMEOUT ?= 120
DESKTOP_PACKAGED_SOAK_REPORT_DIR ?=
DESKTOP_PACKAGED_BACKUP_RESTORE_REPORT_DIR ?= quality/system-audits
DESKTOP_DMG ?= dist/Echo-Founder-$(ECHO_FOUNDER_VERSION)-mac-arm64.dmg
DESKTOP_APP_ZIP ?= dist/Echo-Founder-$(ECHO_FOUNDER_VERSION)-mac-arm64-app.zip
DESKTOP_DMG_VOLUME ?= Echo Founder
DESKTOP_DMG_BUNDLE_ID ?= com.echofounder.desktop
DESKTOP_DMG_SMOKE_INSTALL_DIR ?= /private/tmp/aifios-dmg-smoke-install
DESKTOP_DMG_SMOKE_PROJECT ?= /private/tmp/aifios-dmg-smoke
DESKTOP_DMG_SMOKE_USER_DATA_DIR ?= /private/tmp/aifios-dmg-user-data
DESKTOP_DMG_SMOKE_TIMEOUT ?= 120
DESKTOP_DMG_SMOKE_MINIMAL_ENV ?= 1
DESKTOP_DMG_SMOKE_REQUIRE_PYTHON_SOURCE ?= bundled-runtime
DESKTOP_DMG_OPEN_SMOKE_INSTALL_DIR ?= /private/tmp/aifios-dmg-open-install
DESKTOP_DMG_OPEN_SMOKE_PROJECT ?= /private/tmp/aifios-dmg-open-smoke
DESKTOP_DMG_OPEN_SMOKE_USER_DATA_DIR ?= /private/tmp/aifios-dmg-open-user-data
DESKTOP_DMG_OPEN_SMOKE_TIMEOUT ?= 120
DESKTOP_DMG_OPEN_SMOKE_REQUIRE_PYTHON_SOURCE ?= bundled-runtime
DESKTOP_DMG_OPEN_SMOKE_REPORT_DIR ?= quality/system-audits
DESKTOP_RELEASE_REPORT_DIR ?= quality/system-audits
DESKTOP_SIGN_IDENTITY ?=
DESKTOP_NOTARY_PROFILE ?=
DESKTOP_RELEASE_GATE_MODE ?= quick
DESKTOP_RELEASE_GATE_REQUIRE_PYTHON_SOURCE ?= bundled-runtime
DESKTOP_RELEASE_GATE_FAST_SOAK ?=
DESKTOP_RELEASE_GATE_SKIP_NEXT_BUILD ?=
DESKTOP_RELEASE_GATE_KEEP_GOING ?=
COMMERCIAL_READINESS_REPORT_DIR ?= quality/system-audits
COMMERCIAL_READINESS_ACCEPTANCE_RECORD ?= quality/acceptance/real-account-acceptance.json
COMMERCIAL_READINESS_ACCEPTANCE_PUBLIC_KEY ?=
COMMERCIAL_READINESS_SOAK_SECONDS ?= 1800
INTERNAL_RELEASE_ACCEPTANCE_RECORD ?= quality/acceptance/internal-release-acceptance.json
QUICKSTART_SMOKE_WORK_DIR ?= /private/tmp/aifios-quickstart-smoke
RELEASE_GATE_QUICKSTART_WORK_DIR ?= /private/tmp/aifios-release-gate-quickstart
RELEASE_GATE_SMOKE_WORK_DIR ?= /private/tmp/aifios-release-gate-smoke
RELEASE_GATE_DIST_DIR ?= /private/tmp/aifios-release-gate-dist
RELEASE_GATE_REPORT ?= /private/tmp/aifios-release-gate-report.json
RELEASE_GATE_MARKDOWN_REPORT ?=
RUNTIME := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/content_runtime.py --project $(PROJECT)
DIRECTOR := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/content_pipeline.py --project $(PROJECT)
SESSION := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/session_manager.py --project $(PROJECT)
HIT := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/hit_collector.py --project $(PROJECT)
TIKOMNI_ADAPTER := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/tikomni_adapter.py --project $(PROJECT)
BROWSER_HIT := node $(AIFIOS_HOME)/skills/content-runtime/scripts/browser_hit_collector.mjs --project $(PROJECT)
BROWSER_WECHAT_PERFORMANCE := node $(AIFIOS_HOME)/skills/content-runtime/scripts/wechat_mp_browser_collector.mjs --project $(PROJECT)
BROWSER_HIT_DOCTOR := node $(AIFIOS_HOME)/skills/content-runtime/scripts/browser_hit_doctor.mjs
BROWSER_HIT_FIXTURE_CHECK := node $(AIFIOS_HOME)/skills/content-runtime/scripts/browser_hit_fixture_check.mjs
QUALITY := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/quality_check.py --project $(PROJECT)
DELIVERY := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/delivery_pack.py --project $(PROJECT)
DELIVERY_AUDIT := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/delivery_audit.py --project $(PROJECT)
DBS_FUSION_APPLY := python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/dbs_fusion_apply.py --project $(PROJECT)
CLI := python3 $(AIFIOS_HOME)/scripts/aifios.py --project $(PROJECT)
MATERIAL_OCR_SOURCE := $(AIFIOS_HOME)/skills/content-runtime/scripts/aifios_material_ocr.swift
MATERIAL_OCR_BINARY := $(AIFIOS_HOME)/skills/content-runtime/bin/aifios-material-ocr
MATERIAL_OCR_BUILD_DIR ?= /private/tmp/aifios-material-ocr-build

.PHONY: help version version-check aifios install-cli ui desktop desktop-check desktop-smoke desktop-soak desktop-package desktop-package-hosted desktop-package-traceability desktop-packaged-smoke desktop-packaged-hosted-smoke desktop-packaged-x64-smoke desktop-packaged-open-smoke desktop-packaged-single-instance-smoke desktop-packaged-recovery-smoke desktop-packaged-backup-restore-smoke desktop-packaged-watchdog-smoke desktop-packaged-soak desktop-dmg desktop-dmg-hosted desktop-dmg-verify desktop-dmg-hosted-verify desktop-dmg-smoke desktop-minimal-artifact-check desktop-dmg-open-smoke desktop-notarization-check desktop-sign desktop-notarize desktop-staple desktop-external-verify desktop-external-release desktop-release-assessment desktop-release-gate commercial-readiness-source commercial-readiness-full-automated commercial-readiness-full internal-release-acceptance ui-smoke quickstart-smoke release-gate release-report ui-runtime-gates runtime-contracts content-loop-check material-ocr-build test pytest doctor verify install install-dry-run external-plan demo package smoke-release onboard work cockpit start guide init status next flow read state run runs run-create run-switch run-resume run-archive quality-check delivery-pack delivery-audit dbs-fusion-apply performance-collect-mock performance-collect-wechat performance-collect-wechat-api performance-collect-wechat-browser hit-init hit-add hit-import hit-list hit-report tikomni-hit-import tikomni-performance-import hit-queue-list hit-queue-import hit-queue-reject browser-hit-install browser-hit-doctor browser-hit-fixture-check browser-hit-collect browser-hit-queue session-boot session-state

help:
	@echo "  make version  # show the product, source and newest local artifact status"
	@echo "  make version-check  # fail if active version declarations drift from VERSION"
	@echo "Echo Founder $(ECHO_FOUNDER_VERSION)（AIFI-OS 内部工程）"
	@echo "  make aifios"
	@echo "  make install-cli [BIN_DIR=$(HOME)/.local/bin] [FORCE=1]"
	@echo "  make ui [PORT=3000] [HOST=127.0.0.1] [INSTALL_DEPS=1]"
	@echo "  make desktop [PROJECT=$(HOME)/ai-content-system]"
	@echo "  make desktop-check"
	@echo "  make material-ocr-build (rebuild the universal macOS PDF OCR helper)"
	@echo "  make desktop-smoke [DESKTOP_SMOKE_PROJECT=/private/tmp/aifios-desktop-smoke]"
	@echo "  make desktop-soak [DESKTOP_SOAK_DURATION=1800] [DESKTOP_SOAK_INTERVAL=30]"
	@echo "  make desktop-package DESKTOP_SOCIAL_MEDIA_CRAWL_DIR=/approved/social-media-crawl [DESKTOP_PACKAGE_ARCH=arm64] [DESKTOP_EMBED_PYTHON_RUNTIME=required|auto|off] [archive path + matching SHA overrides]  # social-media-crawl source is required"
	@echo "  make desktop-package-hosted DESKTOP_HOSTED_GATEWAY_URL=https://gateway.example.com [DESKTOP_HOSTED_RESEARCH_PUBLIC_KEY=base64url-public-key]"
	@echo "  make desktop-package-traceability [REQUIRE_CLEAN_SOURCE=1]"
	@echo "  make desktop-packaged-smoke [DESKTOP_PACKAGE_APP='dist/desktop/Echo Founder.app'] [DESKTOP_PACKAGED_MINIMAL_ENV=1]"
	@echo "  make desktop-packaged-hosted-smoke [DESKTOP_PACKAGE_APP='dist/desktop/Echo Founder.app']"
	@echo "  make desktop-packaged-open-smoke [DESKTOP_PACKAGE_APP='dist/desktop/Echo Founder.app'] (isolated HOME, dynamic port, zero AIFIOS_* overrides)"
	@echo "  make desktop-packaged-single-instance-smoke [DESKTOP_PACKAGE_APP='dist/desktop/Echo Founder.app']"
	@echo "  make desktop-packaged-recovery-smoke [DESKTOP_PACKAGE_APP='dist/desktop/Echo Founder.app']"
	@echo "  make desktop-packaged-backup-restore-smoke [DESKTOP_PACKAGE_APP='dist/desktop/Echo Founder.app']"
	@echo "  make desktop-packaged-watchdog-smoke [DESKTOP_PACKAGE_APP='dist/desktop/Echo Founder.app']"
	@echo "  make desktop-packaged-soak [DESKTOP_PACKAGED_SOAK_DURATION=1800] [DESKTOP_PACKAGED_MINIMAL_ENV=1]"
	@echo "  make desktop-dmg [DESKTOP_DMG=dist/Echo-Founder-$(ECHO_FOUNDER_VERSION)-mac-arm64.dmg]"
	@echo "  make desktop-dmg-hosted [DESKTOP_DMG=dist/Echo-Founder-$(ECHO_FOUNDER_VERSION)-mac-arm64.dmg] (refuse local-self-config apps)"
	@echo "  make desktop-dmg-verify"
	@echo "  make desktop-dmg-smoke [DESKTOP_DMG_SMOKE_MINIMAL_ENV=1]"
	@echo "  make desktop-minimal-artifact-check"
	@echo "  make desktop-dmg-open-smoke"
	@echo "  make desktop-notarization-check [DESKTOP_SIGN_IDENTITY='Developer ID Application: ...'] [DESKTOP_NOTARY_PROFILE=...]"
	@echo "  make desktop-external-release [DESKTOP_SIGN_IDENTITY='Developer ID Application: ...'] [DESKTOP_NOTARY_PROFILE=...]"
	@echo "  make desktop-external-verify"
	@echo "  make desktop-release-assessment [REQUIRE_EXTERNAL_READY=1]"
	@echo "  make desktop-release-gate [DESKTOP_RELEASE_GATE_MODE=quick|standard|full]"
	@echo "  make commercial-readiness-source  # 源码自动化预检，不代表真实账号验收"
	@echo "  make commercial-readiness-full-automated [COMMERCIAL_READINESS_SOAK_SECONDS=1800]  # arm64 全量自动化预检"
	@echo "  make commercial-readiness-full COMMERCIAL_READINESS_ACCEPTANCE_PUBLIC_KEY=/secure/qa-public.pem [COMMERCIAL_READINESS_SOAK_SECONDS=1800] [COMMERCIAL_READINESS_ACCEPTANCE_RECORD=quality/acceptance/real-account-acceptance.json]  # 正式交付门禁"
	@echo "  make internal-release-acceptance INTERNAL_RELEASE_ACCEPTANCE_RECORD=quality/acceptance/internal-release-acceptance.json  # 自验内部候选，永不声明商业就绪"
	@echo "  make ui-smoke [BASE_URL=http://localhost:3000]"
	@echo "  make quickstart-smoke [QUICKSTART_SMOKE_WORK_DIR=/private/tmp/aifios-quickstart-smoke]"
	@echo "  make release-gate [ARCHIVE=dist/echo-founder-$(ECHO_FOUNDER_VERSION).tar.gz] [RELEASE_GATE_REPORT=/private/tmp/echo-founder-release-gate-report.json] [RELEASE_GATE_MARKDOWN_REPORT=/path/to/report.md]"
	@echo "  make release-report [RELEASE_GATE_REPORT=/private/tmp/aifios-release-gate-report.json] [RELEASE_GATE_MARKDOWN_REPORT=/path/to/report.md]"
	@echo "  make ui-runtime-gates"
	@echo "  make runtime-contracts"
	@echo "  make content-loop-check"
	@echo "  make test"
	@echo "  make pytest"
	@echo "  make doctor [INSTALL_DIR=$(HOME)/.agents/skills] [REQUIRE_INSTALL=1] [REQUIRE_UI_DEPS=1]"
	@echo "  make verify [INSTALL_DIR=$(HOME)/.agents/skills] [SKIP_INSTALL_CHECK=1] [SKIP_DEMO=1] [SKIP_BROWSER_FIXTURE=1]"
	@echo "  make install [INSTALL_DIR=$(HOME)/.agents/skills] [INSTALL_MODE=symlink|copy] [FORCE=1]"
	@echo "  make install-dry-run"
	@echo "  make external-plan"
	@echo "  make demo [DEMO_PROJECT=/private/tmp/aifios-demo]"
	@echo "  make package [DIST_DIR=dist]"
	@echo "  make smoke-release"
	@echo "  make onboard PROJECT=$(HOME)/ai-content-system PLATFORMS='公众号,小红书' OFFER='...' TARGET='...' PRODUCT='...'"
	@echo "  make work PROJECT=$(HOME)/ai-content-system [INPUT='继续']"
	@echo "  make start PROJECT=$(HOME)/ai-content-system [INPUT='我想写公众号']"
	@echo "  make init PROJECT=$(HOME)/ai-content-system"
	@echo "  make status PROJECT=... [SLUG=...]"
	@echo "  make next PROJECT=... [SLUG=...]"
	@echo "  make run-create PROJECT=... TOPIC='主题' [PLATFORMS='公众号,小红书']"
	@echo "  make run-switch PROJECT=... RUN_ID=..."
	@echo "  make run-resume PROJECT=... [RUN_ID=...]"
	@echo "  make run-archive PROJECT=... [RUN_ID=...]"
	@echo "  make quality-check PROJECT=... PLATFORM=wechat [FILE=...]"
	@echo "  make delivery-pack PROJECT=... [RUN_ID=...]"
	@echo "  make delivery-audit PROJECT=... [RUN_ID=...] [AUTO_PACK=1]"
	@echo "  make dbs-fusion-apply PROJECT=... [FILE=...] [SLUG=...] [DRY_RUN=1] [FORCE=1]"
	@echo "  make performance-collect-mock PROJECT=... SLUG=demo TITLE='测试文章'"
	@echo "  make performance-collect-wechat PROJECT=... FILE=/path/to/wechat-data.json [SLUG=...] [BENCHMARK_REPORT=...]"
	@echo "  make performance-collect-wechat-api PROJECT=... SLUG=... ARTICLE_ID=... PUBLISHED_AT=YYYY-MM-DD [MSG_DATA_ID=...]"
	@echo "  make performance-collect-wechat-browser PROJECT=... SLUG=... [TITLE=...] [AUTO_AFTER_LOGIN=1] [ALL_PUBLISHED=1] [CAPTURE_CONTENT=1]"
	@echo "  make flow PROJECT=... [INTAKE=/path/to/intake.md] [SLUG=...]"
	@echo "  make read PROJECT=... STEP=intake [SLUG=...]"
	@echo "  make hit-init PROJECT=..."
	@echo "  make hit-import PROJECT=... PLATFORM=xhs FILE=/path/to/samples.json"
	@echo "  make hit-report PROJECT=... [PLATFORM=xhs] [KEYWORD=...]"
	@echo "  make tikomni-hit-import PROJECT=/private/tmp/aifios-tikomni PLATFORM=xhs FILE=/tmp/tikomni-xhs.json KEYWORD='AI 创业' QUEUE=1"
	@echo "  make browser-hit-install"
	@echo "  make browser-hit-doctor"
	@echo "  make browser-hit-fixture-check"
	@echo "  make browser-hit-collect PROJECT=... PLATFORM=xhs KEYWORD=..."
	@echo "  make browser-hit-queue PROJECT=... PLATFORM=xhs KEYWORD=..."
	@echo "  make session-boot PROJECT=... [FORCE=1]"

aifios:
	$(CLI) --help

version:
	python3 $(AIFIOS_HOME)/scripts/version_status.py

version-check:
	python3 $(AIFIOS_HOME)/scripts/version_status.py --check

install-cli:
	python3 $(AIFIOS_HOME)/scripts/aifios.py install-cli $(if $(BIN_DIR),--bin-dir "$(BIN_DIR)") $(if $(FORCE),--force) $(if $(DRY_RUN),--dry-run)

ui:
	$(CLI) ui $(if $(HOST),--host $(HOST)) $(if $(PORT),--port $(PORT)) $(if $(INSTALL_DEPS),--install-deps) $(if $(NO_OPEN),--no-open)

desktop:
	@if [ ! -x "$(AIFIOS_HOME)/ui/node_modules/.bin/electron" ]; then \
		echo "Electron 运行文件未安装。先执行：cd $(AIFIOS_HOME)/ui && npm install"; \
		exit 1; \
	fi
	cd $(AIFIOS_HOME)/ui && AIFIOS_HOME="$(AIFIOS_HOME)" AIFIOS_PROJECT="$(PROJECT)" AIFIOS_SKILLS_DIR="$(AIFIOS_HOME)/skills" npm run desktop

desktop-check:
	cd $(AIFIOS_HOME)/ui && npm run desktop:check

material-ocr-build:
	@command -v swiftc >/dev/null || (echo "swiftc is required to build the macOS PDF OCR helper"; exit 1)
	@command -v lipo >/dev/null || (echo "lipo is required to build the universal macOS PDF OCR helper"; exit 1)
	mkdir -p "$(MATERIAL_OCR_BUILD_DIR)" "$(dir $(MATERIAL_OCR_BINARY))"
	swiftc -O -target arm64-apple-macosx13.0 -framework AppKit -framework PDFKit -framework Vision "$(MATERIAL_OCR_SOURCE)" -o "$(MATERIAL_OCR_BUILD_DIR)/aifios-material-ocr-arm64"
	swiftc -O -target x86_64-apple-macosx13.0 -framework AppKit -framework PDFKit -framework Vision "$(MATERIAL_OCR_SOURCE)" -o "$(MATERIAL_OCR_BUILD_DIR)/aifios-material-ocr-x64"
	lipo -create -output "$(MATERIAL_OCR_BINARY)" "$(MATERIAL_OCR_BUILD_DIR)/aifios-material-ocr-arm64" "$(MATERIAL_OCR_BUILD_DIR)/aifios-material-ocr-x64"
	chmod 755 "$(MATERIAL_OCR_BINARY)"
	lipo -archs "$(MATERIAL_OCR_BINARY)"

desktop-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_smoke.py --project-dir "$(DESKTOP_SMOKE_PROJECT)" --timeout "$(DESKTOP_SMOKE_TIMEOUT)" $(if $(PORT),--port $(PORT))

desktop-soak:
	python3 $(AIFIOS_HOME)/scripts/desktop_soak.py --project-dir "$(DESKTOP_SOAK_PROJECT)" --duration-seconds "$(DESKTOP_SOAK_DURATION)" --interval-seconds "$(DESKTOP_SOAK_INTERVAL)" --startup-timeout "$(DESKTOP_SOAK_STARTUP_TIMEOUT)" $(if $(PORT),--port $(PORT))

desktop-package:
	python3 $(AIFIOS_HOME)/scripts/desktop_package.py --dist-dir "$(DESKTOP_PACKAGE_DIST)" --app-name "$(DESKTOP_APP_NAME)" --version "$(ECHO_FOUNDER_VERSION)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --arch "$(DESKTOP_PACKAGE_ARCH)" $(if $(DESKTOP_RELEASE_BASELINE_SHA),--baseline-sha "$(DESKTOP_RELEASE_BASELINE_SHA)") --embed-python-runtime "$(DESKTOP_EMBED_PYTHON_RUNTIME)" --python-version "$(DESKTOP_PYTHON_VERSION)" $(DESKTOP_SUPPLY_CHAIN_ARCHIVE_ARGS) $(if $(DESKTOP_SOCIAL_MEDIA_CRAWL_DIR),--social-media-crawl-dir "$(DESKTOP_SOCIAL_MEDIA_CRAWL_DIR)") $(if $(SKIP_BUILD),--skip-build) $(if $(NO_CODESIGN),--no-codesign)

desktop-package-hosted:
	@test -n "$(DESKTOP_HOSTED_GATEWAY_URL)" || (echo "DESKTOP_HOSTED_GATEWAY_URL is required"; exit 1)
	python3 $(AIFIOS_HOME)/scripts/desktop_package.py --dist-dir "$(DESKTOP_PACKAGE_DIST)" --app-name "$(DESKTOP_APP_NAME)" --version "$(ECHO_FOUNDER_VERSION)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --arch "$(DESKTOP_PACKAGE_ARCH)" $(if $(DESKTOP_RELEASE_BASELINE_SHA),--baseline-sha "$(DESKTOP_RELEASE_BASELINE_SHA)") --hosted-gateway-url "$(DESKTOP_HOSTED_GATEWAY_URL)" $(if $(DESKTOP_HOSTED_RESEARCH_PUBLIC_KEY),--hosted-research-public-key "$(DESKTOP_HOSTED_RESEARCH_PUBLIC_KEY)" --hosted-research-key-id "$(DESKTOP_HOSTED_RESEARCH_KEY_ID)") --embed-python-runtime "$(DESKTOP_EMBED_PYTHON_RUNTIME)" --python-version "$(DESKTOP_PYTHON_VERSION)" $(DESKTOP_SUPPLY_CHAIN_ARCHIVE_ARGS) $(if $(DESKTOP_SOCIAL_MEDIA_CRAWL_DIR),--social-media-crawl-dir "$(DESKTOP_SOCIAL_MEDIA_CRAWL_DIR)") $(if $(SKIP_BUILD),--skip-build) $(if $(NO_CODESIGN),--no-codesign)

desktop-package-traceability:
	python3 $(AIFIOS_HOME)/scripts/desktop_package.py --verify-manifest "$(DESKTOP_PACKAGE_MANIFEST)" --verify-app-path "$(DESKTOP_PACKAGE_APP)" $(if $(filter 1 true yes,$(REQUIRE_CLEAN_SOURCE)),--require-clean-source)

desktop-packaged-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_smoke.py --app-path "$(DESKTOP_PACKAGE_APP)" --project-dir "$(DESKTOP_PACKAGE_PROJECT)" --user-data-dir "$(DESKTOP_PACKAGE_USER_DATA_DIR)" --timeout "$(DESKTOP_PACKAGE_TIMEOUT)" --expected-architecture "$(DESKTOP_PACKAGED_EXPECTED_ARCH)" $(if $(PORT),--port $(PORT)) $(if $(filter 1 true yes,$(DESKTOP_PACKAGED_MINIMAL_ENV)),--minimal-env) $(if $(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE)")

desktop-packaged-hosted-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_smoke.py --app-path "$(DESKTOP_PACKAGE_APP)" --project-dir "$(DESKTOP_PACKAGE_PROJECT)" --user-data-dir "$(DESKTOP_PACKAGE_USER_DATA_DIR)" --timeout "$(DESKTOP_PACKAGE_TIMEOUT)" --expected-architecture "$(DESKTOP_PACKAGED_EXPECTED_ARCH)" --expect-hosted-license $(if $(PORT),--port $(PORT)) $(if $(filter 1 true yes,$(DESKTOP_PACKAGED_MINIMAL_ENV)),--minimal-env) $(if $(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE)")

desktop-packaged-x64-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_smoke.py --app-path "$(DESKTOP_PACKAGE_APP)" --project-dir "$(DESKTOP_PACKAGED_X64_PROJECT)" --user-data-dir "$(DESKTOP_PACKAGED_X64_USER_DATA_DIR)" --timeout "$(DESKTOP_PACKAGED_X64_TIMEOUT)" --expected-architecture "$(DESKTOP_PACKAGED_X64_EXPECTED_ARCH)" --launch-architecture x64 $(if $(PORT),--port $(PORT)) $(if $(filter 1 true yes,$(DESKTOP_PACKAGED_MINIMAL_ENV)),--minimal-env) $(if $(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE)")

desktop-packaged-open-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_open_smoke.py --app-path "$(DESKTOP_PACKAGE_APP)" --default-first-launch --timeout "$(DESKTOP_PACKAGED_OPEN_TIMEOUT)" --report-dir "$(DESKTOP_PACKAGED_OPEN_REPORT_DIR)" $(if $(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE)")

desktop-packaged-single-instance-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_single_instance_smoke.py --app-path "$(DESKTOP_PACKAGE_APP)" --project-dir "$(DESKTOP_PACKAGED_SINGLE_INSTANCE_PROJECT)" --user-data-dir "$(DESKTOP_PACKAGED_SINGLE_INSTANCE_USER_DATA_DIR)" --timeout "$(DESKTOP_PACKAGED_SINGLE_INSTANCE_TIMEOUT)" --duplicate-exit-timeout "$(DESKTOP_PACKAGED_SINGLE_INSTANCE_DUPLICATE_TIMEOUT)" --report-dir "$(DESKTOP_PACKAGED_SINGLE_INSTANCE_REPORT_DIR)" $(if $(PORT),--port $(PORT)) $(if $(filter 1 true yes,$(DESKTOP_PACKAGED_MINIMAL_ENV)),--minimal-env) $(if $(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE)")

desktop-packaged-recovery-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_recovery_smoke.py --app-path "$(DESKTOP_PACKAGE_APP)" --project-dir "$(DESKTOP_PACKAGED_RECOVERY_PROJECT)" --user-data-dir "$(DESKTOP_PACKAGED_RECOVERY_USER_DATA_DIR)" --timeout "$(DESKTOP_PACKAGED_RECOVERY_TIMEOUT)" --recovery-timeout "$(DESKTOP_PACKAGED_RECOVERY_RESTART_TIMEOUT)" --report-dir "$(DESKTOP_PACKAGED_RECOVERY_REPORT_DIR)" $(if $(PORT),--port $(PORT)) $(if $(filter 1 true yes,$(DESKTOP_PACKAGED_MINIMAL_ENV)),--minimal-env) $(if $(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE)")

desktop-packaged-backup-restore-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_backup_restore_smoke.py --app-path "$(DESKTOP_PACKAGE_APP)" --report-dir "$(DESKTOP_PACKAGED_BACKUP_RESTORE_REPORT_DIR)"

desktop-packaged-watchdog-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_watchdog_smoke.py --app-path "$(DESKTOP_PACKAGE_APP)" --project-dir "$(DESKTOP_PACKAGED_WATCHDOG_PROJECT)" --user-data-dir "$(DESKTOP_PACKAGED_WATCHDOG_USER_DATA_DIR)" --timeout "$(DESKTOP_PACKAGED_WATCHDOG_TIMEOUT)" --recovery-timeout "$(DESKTOP_PACKAGED_WATCHDOG_RESTART_TIMEOUT)" --report-dir "$(DESKTOP_PACKAGED_WATCHDOG_REPORT_DIR)" $(if $(PORT),--port $(PORT)) $(if $(filter 1 true yes,$(DESKTOP_PACKAGED_MINIMAL_ENV)),--minimal-env) $(if $(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE)")

desktop-packaged-soak:
	python3 $(AIFIOS_HOME)/scripts/desktop_packaged_soak.py --app-path "$(DESKTOP_PACKAGE_APP)" --project-dir "$(DESKTOP_PACKAGED_SOAK_PROJECT)" --user-data-dir "$(DESKTOP_PACKAGED_SOAK_USER_DATA_DIR)" --duration-seconds "$(DESKTOP_PACKAGED_SOAK_DURATION)" --interval-seconds "$(DESKTOP_PACKAGED_SOAK_INTERVAL)" --startup-timeout "$(DESKTOP_PACKAGED_SOAK_STARTUP_TIMEOUT)" $(if $(PORT),--port $(PORT)) $(if $(filter 1 true yes,$(DESKTOP_PACKAGED_MINIMAL_ENV)),--minimal-env) $(if $(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_PACKAGED_REQUIRE_PYTHON_SOURCE)") $(if $(DESKTOP_PACKAGED_SOAK_REPORT_DIR),--report-dir "$(DESKTOP_PACKAGED_SOAK_REPORT_DIR)")

desktop-dmg:
	python3 $(AIFIOS_HOME)/scripts/desktop_dmg.py build --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --volume-name "$(DESKTOP_DMG_VOLUME)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --arch "$(DESKTOP_PACKAGE_ARCH)"

desktop-dmg-hosted:
	python3 $(AIFIOS_HOME)/scripts/desktop_dmg.py build --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --volume-name "$(DESKTOP_DMG_VOLUME)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --arch "$(DESKTOP_PACKAGE_ARCH)" --require-hosted-license

desktop-dmg-verify:
	python3 $(AIFIOS_HOME)/scripts/desktop_dmg.py verify --dmg-path "$(DESKTOP_DMG)" --app-name "$(DESKTOP_APP_NAME)" --volume-name "$(DESKTOP_DMG_VOLUME)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --arch "$(DESKTOP_PACKAGE_ARCH)"

desktop-dmg-hosted-verify:
	python3 $(AIFIOS_HOME)/scripts/desktop_dmg.py verify --dmg-path "$(DESKTOP_DMG)" --app-name "$(DESKTOP_APP_NAME)" --volume-name "$(DESKTOP_DMG_VOLUME)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --arch "$(DESKTOP_PACKAGE_ARCH)" --require-hosted-license

desktop-dmg-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_dmg_smoke.py --dmg-path "$(DESKTOP_DMG)" --app-name "$(DESKTOP_APP_NAME)" --install-dir "$(DESKTOP_DMG_SMOKE_INSTALL_DIR)" --project-dir "$(DESKTOP_DMG_SMOKE_PROJECT)" --user-data-dir "$(DESKTOP_DMG_SMOKE_USER_DATA_DIR)" --timeout "$(DESKTOP_DMG_SMOKE_TIMEOUT)" $(if $(PORT),--port $(PORT)) $(if $(filter 1 true yes,$(DESKTOP_DMG_SMOKE_MINIMAL_ENV)),--minimal-env) $(if $(DESKTOP_DMG_SMOKE_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_DMG_SMOKE_REQUIRE_PYTHON_SOURCE)")

desktop-minimal-artifact-check:
	python3 $(AIFIOS_HOME)/scripts/desktop_minimal_artifact_check.py --dmg-path "$(DESKTOP_DMG)" --app-name "$(DESKTOP_APP_NAME)" --volume-name "$(DESKTOP_DMG_VOLUME)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)"

desktop-dmg-open-smoke:
	python3 $(AIFIOS_HOME)/scripts/desktop_dmg_open_smoke.py --dmg-path "$(DESKTOP_DMG)" --app-name "$(DESKTOP_APP_NAME)" --install-dir "$(DESKTOP_DMG_OPEN_SMOKE_INSTALL_DIR)" --default-first-launch --timeout "$(DESKTOP_DMG_OPEN_SMOKE_TIMEOUT)" --report-dir "$(DESKTOP_DMG_OPEN_SMOKE_REPORT_DIR)" $(if $(DESKTOP_DMG_OPEN_SMOKE_REQUIRE_PYTHON_SOURCE),--require-python-source "$(DESKTOP_DMG_OPEN_SMOKE_REQUIRE_PYTHON_SOURCE)")

desktop-notarization-check:
	python3 $(AIFIOS_HOME)/scripts/desktop_notarize.py check-config --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --app-zip-path "$(DESKTOP_APP_ZIP)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --volume-name "$(DESKTOP_DMG_VOLUME)" --report-dir "$(DESKTOP_RELEASE_REPORT_DIR)" $(if $(DESKTOP_SIGN_IDENTITY),--identity "$(DESKTOP_SIGN_IDENTITY)") $(if $(DESKTOP_NOTARY_PROFILE),--notary-profile "$(DESKTOP_NOTARY_PROFILE)")

desktop-sign:
	python3 $(AIFIOS_HOME)/scripts/desktop_notarize.py sign --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --app-zip-path "$(DESKTOP_APP_ZIP)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --volume-name "$(DESKTOP_DMG_VOLUME)" --report-dir "$(DESKTOP_RELEASE_REPORT_DIR)" $(if $(DESKTOP_SIGN_IDENTITY),--identity "$(DESKTOP_SIGN_IDENTITY)") $(if $(DESKTOP_NOTARY_PROFILE),--notary-profile "$(DESKTOP_NOTARY_PROFILE)")

desktop-notarize:
	python3 $(AIFIOS_HOME)/scripts/desktop_notarize.py notarize --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --app-zip-path "$(DESKTOP_APP_ZIP)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --volume-name "$(DESKTOP_DMG_VOLUME)" --report-dir "$(DESKTOP_RELEASE_REPORT_DIR)" $(if $(DESKTOP_SIGN_IDENTITY),--identity "$(DESKTOP_SIGN_IDENTITY)") $(if $(DESKTOP_NOTARY_PROFILE),--notary-profile "$(DESKTOP_NOTARY_PROFILE)")

desktop-staple:
	python3 $(AIFIOS_HOME)/scripts/desktop_notarize.py staple --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --app-zip-path "$(DESKTOP_APP_ZIP)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --volume-name "$(DESKTOP_DMG_VOLUME)" --report-dir "$(DESKTOP_RELEASE_REPORT_DIR)" $(if $(DESKTOP_SIGN_IDENTITY),--identity "$(DESKTOP_SIGN_IDENTITY)") $(if $(DESKTOP_NOTARY_PROFILE),--notary-profile "$(DESKTOP_NOTARY_PROFILE)")

desktop-external-verify:
	python3 $(AIFIOS_HOME)/scripts/desktop_notarize.py verify --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --app-zip-path "$(DESKTOP_APP_ZIP)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --volume-name "$(DESKTOP_DMG_VOLUME)" --report-dir "$(DESKTOP_RELEASE_REPORT_DIR)" $(if $(DESKTOP_SIGN_IDENTITY),--identity "$(DESKTOP_SIGN_IDENTITY)") $(if $(DESKTOP_NOTARY_PROFILE),--notary-profile "$(DESKTOP_NOTARY_PROFILE)")

desktop-external-release:
	python3 $(AIFIOS_HOME)/scripts/desktop_notarize.py release --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --app-zip-path "$(DESKTOP_APP_ZIP)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --volume-name "$(DESKTOP_DMG_VOLUME)" --report-dir "$(DESKTOP_RELEASE_REPORT_DIR)" $(if $(DESKTOP_SIGN_IDENTITY),--identity "$(DESKTOP_SIGN_IDENTITY)") $(if $(DESKTOP_NOTARY_PROFILE),--notary-profile "$(DESKTOP_NOTARY_PROFILE)")

desktop-release-assessment:
	python3 $(AIFIOS_HOME)/scripts/desktop_release_assessment.py --app-path "$(DESKTOP_PACKAGE_APP)" --dmg-path "$(DESKTOP_DMG)" --bundle-id "$(DESKTOP_DMG_BUNDLE_ID)" --arch "$(DESKTOP_PACKAGE_ARCH)" --report-dir "$(DESKTOP_RELEASE_REPORT_DIR)" $(if $(REQUIRE_EXTERNAL_READY),--require-external-ready)

desktop-release-gate:
	python3 $(AIFIOS_HOME)/scripts/desktop_release_gate.py --mode "$(DESKTOP_RELEASE_GATE_MODE)" --report-dir "$(DESKTOP_RELEASE_REPORT_DIR)" --require-python-source "$(DESKTOP_RELEASE_GATE_REQUIRE_PYTHON_SOURCE)" $(if $(REQUIRE_EXTERNAL_READY),--require-external-ready) $(if $(DESKTOP_RELEASE_GATE_FAST_SOAK),--fast-soak) $(if $(DESKTOP_RELEASE_GATE_SKIP_NEXT_BUILD),--skip-next-build) $(if $(DESKTOP_RELEASE_GATE_KEEP_GOING),--keep-going)

commercial-readiness-source:
	python3 $(AIFIOS_HOME)/scripts/commercial_readiness_gate.py --mode source --report-dir "$(COMMERCIAL_READINESS_REPORT_DIR)" --automated-only

commercial-readiness-full-automated:
	python3 $(AIFIOS_HOME)/scripts/commercial_readiness_gate.py --mode full --report-dir "$(COMMERCIAL_READINESS_REPORT_DIR)" --soak-seconds "$(COMMERCIAL_READINESS_SOAK_SECONDS)" --automated-only

commercial-readiness-full: $(COMMERCIAL_READINESS_ACCEPTANCE_RECORD)
	@test -n "$(COMMERCIAL_READINESS_ACCEPTANCE_PUBLIC_KEY)" || (echo "COMMERCIAL_READINESS_ACCEPTANCE_PUBLIC_KEY is required for an independently signed commercial acceptance"; exit 1)
	python3 $(AIFIOS_HOME)/scripts/commercial_readiness_gate.py --mode full --verify-frozen-artifacts --report-dir "$(COMMERCIAL_READINESS_REPORT_DIR)" --soak-seconds "$(COMMERCIAL_READINESS_SOAK_SECONDS)" --acceptance-record "$(COMMERCIAL_READINESS_ACCEPTANCE_RECORD)" --acceptance-public-key "$(COMMERCIAL_READINESS_ACCEPTANCE_PUBLIC_KEY)"

internal-release-acceptance: $(INTERNAL_RELEASE_ACCEPTANCE_RECORD)
	python3 $(AIFIOS_HOME)/scripts/internal_release_acceptance.py --acceptance "$(INTERNAL_RELEASE_ACCEPTANCE_RECORD)"

ui-smoke:
	python3 $(AIFIOS_HOME)/scripts/ui_smoke.py $(if $(BASE_URL),--base-url "$(BASE_URL)")

quickstart-smoke:
	python3 $(AIFIOS_HOME)/scripts/quickstart_smoke.py $(if $(ARCHIVE),--archive "$(ARCHIVE)") --work-dir "$(QUICKSTART_SMOKE_WORK_DIR)"

release-gate:
	python3 $(AIFIOS_HOME)/scripts/release_gate.py $(if $(ARCHIVE),--archive "$(ARCHIVE)") --dist-dir "$(RELEASE_GATE_DIST_DIR)" --quickstart-work-dir "$(RELEASE_GATE_QUICKSTART_WORK_DIR)" --smoke-work-dir "$(RELEASE_GATE_SMOKE_WORK_DIR)" --report "$(RELEASE_GATE_REPORT)" $(if $(RELEASE_GATE_MARKDOWN_REPORT),--markdown-report "$(RELEASE_GATE_MARKDOWN_REPORT)")

release-report:
	python3 $(AIFIOS_HOME)/scripts/aifios.py release-report --report "$(RELEASE_GATE_REPORT)" $(if $(RELEASE_GATE_MARKDOWN_REPORT),--markdown-report "$(RELEASE_GATE_MARKDOWN_REPORT)",--write-markdown)

ui-runtime-gates:
	python3 $(AIFIOS_HOME)/scripts/check_ui_runtime_gates.py

runtime-contracts:
	python3 $(AIFIOS_HOME)/scripts/version_status.py --check
	python3 $(AIFIOS_HOME)/scripts/check_runtime_contracts.py

content-loop-check:
	python3 $(AIFIOS_HOME)/scripts/check_content_production_loop.py

test:
	python3 $(AIFIOS_HOME)/skills/content-runtime/scripts/check_manifest.py
	python3 $(AIFIOS_HOME)/scripts/version_status.py --check
	python3 $(AIFIOS_HOME)/scripts/check_runtime_contracts.py
	python3 $(AIFIOS_HOME)/scripts/check_content_production_loop.py
	$(MAKE) -C $(AIFIOS_HOME)/skills/content-runtime test

pytest:
	python3 -m pytest

doctor:
	python3 $(AIFIOS_HOME)/scripts/doctor.py --install-dir $(INSTALL_DIR) $(if $(STRICT),--strict) $(if $(REQUIRE_INSTALL),--require-install) $(if $(REQUIRE_EXTERNAL),--require-external) $(if $(REQUIRE_UI_DEPS),--require-ui-deps) $(if $(SKIP_UI),--skip-ui) $(if $(SHOW_RESOLUTIONS),--show-resolutions)

verify:
	python3 $(AIFIOS_HOME)/scripts/aifios.py verify --install-dir $(INSTALL_DIR) $(if $(DEMO_PROJECT),--demo-project "$(DEMO_PROJECT)") $(if $(REPORT),--report "$(REPORT)") $(if $(STRICT),--strict) $(if $(SKIP_INSTALL_CHECK),--skip-install-check) $(if $(REQUIRE_EXTERNAL),--require-external) $(if $(REQUIRE_UI_DEPS),--require-ui-deps) $(if $(SKIP_UI),--skip-ui) $(if $(SKIP_TESTS),--skip-tests) $(if $(SKIP_DEMO),--skip-demo) $(if $(SKIP_BROWSER_FIXTURE),--skip-browser-fixture)

install:
	python3 $(AIFIOS_HOME)/scripts/install.py --install-dir $(INSTALL_DIR) --mode $(INSTALL_MODE) $(if $(FORCE),--force)

install-dry-run:
	python3 $(AIFIOS_HOME)/scripts/install.py --install-dir $(INSTALL_DIR) --mode $(INSTALL_MODE) --dry-run $(if $(FORCE),--force)

external-plan:
	python3 $(AIFIOS_HOME)/scripts/install.py --external-plan

demo:
	python3 $(AIFIOS_HOME)/scripts/demo.py --project $(DEMO_PROJECT) $(if $(SLUG),--slug "$(SLUG)") $(if $(PLATFORM),--platform "$(PLATFORM)") --reset

package:
	python3 $(AIFIOS_HOME)/scripts/package.py --dist-dir $(DIST_DIR)

smoke-release:
	python3 $(AIFIOS_HOME)/scripts/smoke_release.py $(if $(ARCHIVE),--archive $(ARCHIVE)) $(if $(WORK_DIR),--work-dir $(WORK_DIR))

start:
	$(SESSION) start $(if $(INPUT),"$(INPUT)") $(if $(JSON),--json)

guide: start

onboard:
	$(SESSION) onboard $(if $(GOAL),--goal "$(GOAL)") $(if $(PLATFORMS),--platforms "$(PLATFORMS)") $(if $(OFFER),--offer "$(OFFER)") $(if $(TARGET),--target "$(TARGET)") $(if $(PRODUCT),--product "$(PRODUCT)") $(if $(JSON),--json)

work:
	$(SESSION) work $(if $(INPUT),"$(INPUT)") $(if $(JSON),--json)

cockpit: work

init:
	$(RUNTIME) init

status:
	$(DIRECTOR) $(if $(SLUG),--slug $(SLUG)) status

next:
	$(DIRECTOR) $(if $(SLUG),--slug $(SLUG)) next

flow:
	$(DIRECTOR) flow $(if $(INTAKE),--intake $(INTAKE)) $(if $(SLUG),--slug $(SLUG))

read:
	@if [ -z "$(STEP)" ]; then \
		echo "用法: make read PROJECT=... STEP=intake [SLUG=...]"; \
		exit 1; \
	fi
	$(RUNTIME) read --step $(STEP) --latest $(if $(SLUG),--slug $(SLUG))

state:
	$(RUNTIME) state

runs:
	$(RUNTIME) runs $(if $(LIMIT),--limit $(LIMIT))

run:
	$(RUNTIME) run $(if $(RUN_ID),--run-id $(RUN_ID)) $(if $(SLUG),--slug $(SLUG))

run-create:
	$(RUNTIME) run-create $(if $(TOPIC),--topic "$(TOPIC)") $(if $(PLATFORMS),--platforms "$(PLATFORMS)") $(if $(SLUG),--slug "$(SLUG)") $(if $(RUN_ID),--run-id "$(RUN_ID)")

run-switch:
	@if [ -z "$(RUN_ID)" ]; then \
		echo "用法: make run-switch PROJECT=... RUN_ID=..."; \
		exit 1; \
	fi
	$(RUNTIME) run-switch --run-id "$(RUN_ID)"

run-resume:
	$(RUNTIME) run-resume $(if $(RUN_ID),--run-id "$(RUN_ID)")

run-archive:
	$(RUNTIME) run-archive $(if $(RUN_ID),--run-id "$(RUN_ID)")

quality-check:
	@if [ -z "$(PLATFORM)" ]; then \
		echo "用法: make quality-check PROJECT=... PLATFORM=wechat [FILE=/path/to/output.md] [SLUG=...]"; \
		exit 1; \
	fi
	$(QUALITY) --platform $(PLATFORM) $(if $(FILE),--file "$(FILE)") $(if $(STEP),--step "$(STEP)") $(if $(SLUG),--slug "$(SLUG)") $(if $(MIN_SCORE),--min-score $(MIN_SCORE))

delivery-pack:
	$(DELIVERY) $(if $(RUN_ID),--run-id "$(RUN_ID)") $(if $(SLUG),--slug "$(SLUG)")

delivery-audit:
	$(DELIVERY_AUDIT) $(if $(RUN_ID),--run-id "$(RUN_ID)") $(if $(SLUG),--slug "$(SLUG)") $(if $(AUTO_PACK),--auto-pack)

dbs-fusion-apply:
	$(DBS_FUSION_APPLY) $(if $(FILE),--file "$(FILE)") $(if $(SLUG),--slug "$(SLUG)") $(if $(DRY_RUN),--dry-run) $(if $(FORCE),--force)

performance-collect-mock:
	$(CLI) performance mock-wechat --slug "$(SLUG)" --title "$(TITLE)"

performance-collect-wechat:
	@if [ -z "$(FILE)" ] && [ -z "$(TITLE)" ]; then \
		echo "用法: make performance-collect-wechat PROJECT=... FILE=/path/to/wechat-data.json [SLUG=...] 或 TITLE='标题' READS=100 LIKES=10"; \
		exit 1; \
	fi
	$(CLI) performance wechat $(if $(FILE),--file "$(FILE)") $(if $(SLUG),--slug "$(SLUG)") $(if $(TITLE),--title "$(TITLE)") $(if $(ARTICLE_ID),--article-id "$(ARTICLE_ID)") $(if $(PUBLISH_URL),--publish-url "$(PUBLISH_URL)") $(if $(PUBLISHED_AT),--published-at "$(PUBLISHED_AT)") $(if $(PUBLISH_ASSET),--publish-asset "$(PUBLISH_ASSET)") $(if $(AUTHORIZATION_MODE),--authorization-mode "$(AUTHORIZATION_MODE)") $(if $(AUTHORIZATION_RECORD),--authorization-record "$(AUTHORIZATION_RECORD)") $(if $(DATA_SOURCE),--data-source "$(DATA_SOURCE)") $(if $(CAPTURED_BY),--captured-by "$(CAPTURED_BY)") $(if $(EVIDENCE),--evidence "$(EVIDENCE)") $(if $(BENCHMARK_REPORT),--benchmark-report "$(BENCHMARK_REPORT)") $(if $(EXPOSURES),--exposures $(EXPOSURES)) $(if $(READS),--reads $(READS)) $(if $(READERS),--readers $(READERS)) $(if $(LIKES),--likes $(LIKES)) $(if $(WOWS),--wows $(WOWS)) $(if $(COMMENTS),--comments $(COMMENTS)) $(if $(SHARES),--shares $(SHARES)) $(if $(COLLECTS),--collects $(COLLECTS)) $(if $(NEW_FOLLOWERS),--new-followers $(NEW_FOLLOWERS)) $(if $(PROFILE_VISITS),--profile-visits $(PROFILE_VISITS)) $(if $(LEADS),--leads $(LEADS))

performance-collect-wechat-api:
	@if [ -z "$(SLUG)" ] || [ -z "$(ARTICLE_ID)" ] || [ -z "$(PUBLISHED_AT)" ]; then \
		echo "用法: make performance-collect-wechat-api PROJECT=... SLUG=... ARTICLE_ID=... PUBLISHED_AT=YYYY-MM-DD [MSG_DATA_ID=...]"; \
		exit 1; \
	fi
	$(CLI) performance wechat-api --slug "$(SLUG)" --article-id "$(ARTICLE_ID)" --published-at "$(PUBLISHED_AT)" $(if $(MSG_DATA_ID),--msg-data-id "$(MSG_DATA_ID)") $(if $(COMMENT_LIMIT),--comment-limit "$(COMMENT_LIMIT)") $(if $(BENCHMARK_REPORT),--benchmark-report "$(BENCHMARK_REPORT)")

performance-collect-wechat-browser:
	@if [ -z "$(SLUG)" ]; then \
		echo "用法: make performance-collect-wechat-browser PROJECT=... SLUG=... [TITLE=...] [AUTO_AFTER_LOGIN=1] [ALL_PUBLISHED=1] [CAPTURE_CONTENT=1]"; \
		exit 1; \
	fi
	$(BROWSER_WECHAT_PERFORMANCE) --slug "$(SLUG)" $(if $(TITLE),--title "$(TITLE)") $(if $(PUBLISH_URL),--publish-url "$(PUBLISH_URL)") $(if $(PUBLISHED_AT),--published-at "$(PUBLISHED_AT)") $(if $(URL),--url "$(URL)") $(if $(PROFILE),--profile "$(PROFILE)") $(if $(AUTO_AFTER_LOGIN),--auto-after-login) $(if $(ALL_PUBLISHED),--all-published) $(if $(CAPTURE_CONTENT),--capture-content) $(if $(AUTO_TIMEOUT_MS),--auto-timeout-ms "$(AUTO_TIMEOUT_MS)") $(if $(MAX_ARTICLES),--max-articles "$(MAX_ARTICLES)") $(if $(MAX_PAGES),--max-pages "$(MAX_PAGES)") $(if $(NO_WAIT),--no-wait) $(if $(HEADLESS),--headless)

hit-init:
	$(HIT) init

hit-add:
	@if [ -z "$(PLATFORM)" ] || [ -z "$(TITLE)" ]; then \
		echo "用法: make hit-add PROJECT=... PLATFORM=xhs TITLE='标题' [LIKES=100] [COMMENTS=10]"; \
		exit 1; \
	fi
	$(HIT) add --platform $(PLATFORM) --title "$(TITLE)" $(if $(URL),--url "$(URL)") $(if $(AUTHOR),--author "$(AUTHOR)") $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(TOPIC),--topic "$(TOPIC)") $(if $(COVER_TEXT),--cover-text "$(COVER_TEXT)") $(if $(HOOK),--hook "$(HOOK)") $(if $(AUDIENCE_PAIN),--audience-pain "$(AUDIENCE_PAIN)") $(if $(COMMERCIAL_ANGLE),--commercial-angle "$(COMMERCIAL_ANGLE)") $(if $(WHY),--why-it-worked "$(WHY)") $(if $(TAGS),--tags "$(TAGS)") $(if $(READS),--reads $(READS)) $(if $(LIKES),--likes $(LIKES)) $(if $(COLLECTS),--collects $(COLLECTS)) $(if $(COMMENTS),--comments $(COMMENTS)) $(if $(SHARES),--shares $(SHARES)) $(if $(WOWS),--wows $(WOWS)) $(if $(RECOMMENDS),--recommends $(RECOMMENDS))

hit-import:
	@if [ -z "$(PLATFORM)" ] || [ -z "$(FILE)" ]; then \
		echo "用法: make hit-import PROJECT=... PLATFORM=xhs FILE=/path/to/samples.json [FORMAT=json|csv|text] [KEYWORD=...]"; \
		exit 1; \
	fi
	$(HIT) import --platform $(PLATFORM) --file $(FILE) $(if $(FORMAT),--format $(FORMAT)) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(TOPIC),--topic "$(TOPIC)") $(if $(PREVIEW),--preview) $(if $(CONFIRM),--confirm)

hit-list:
	$(HIT) list $(if $(PLATFORM),--platform $(PLATFORM)) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(LIMIT),--limit $(LIMIT))

hit-report:
	$(HIT) report $(if $(PLATFORM),--platform $(PLATFORM)) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(LIMIT),--limit $(LIMIT))

tikomni-hit-import:
	@if [ -z "$(PLATFORM)" ] || [ -z "$(FILE)" ]; then \
		echo "用法: make tikomni-hit-import PROJECT=/private/tmp/aifios-tikomni PLATFORM=xhs FILE=/tmp/tikomni-xhs.json KEYWORD='AI 创业' QUEUE=1"; \
		exit 1; \
	fi
	$(TIKOMNI_ADAPTER) hit-import --platform $(PLATFORM) --file "$(FILE)" $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(TOPIC),--topic "$(TOPIC)") $(if $(QUEUE),--queue)

tikomni-performance-import:
	@if [ -z "$(PLATFORM)" ] || [ -z "$(FILE)" ] || [ -z "$(SLUG)" ]; then \
		echo "用法: make tikomni-performance-import PROJECT=/private/tmp/aifios-tikomni PLATFORM=xhs FILE=/tmp/tikomni-xhs.json SLUG=xhs-20260710-ai-consulting"; \
		exit 1; \
	fi
	$(TIKOMNI_ADAPTER) performance-import --platform $(PLATFORM) --file "$(FILE)" --slug "$(SLUG)" $(if $(AUTHORIZATION_MODE),--authorization-mode "$(AUTHORIZATION_MODE)") $(if $(CAPTURED_BY),--captured-by "$(CAPTURED_BY)")

hit-queue-list:
	$(HIT) queue-list

hit-queue-import:
	@if [ -z "$(FILE)" ]; then \
		echo "用法: make hit-queue-import PROJECT=... FILE=/path/to/pending.json [CONFIRM=1]"; \
		exit 1; \
	fi
	$(HIT) queue-import --file "$(FILE)" $(if $(CONFIRM),--confirm)

hit-queue-reject:
	@if [ -z "$(FILE)" ]; then \
		echo "用法: make hit-queue-reject PROJECT=... FILE=/path/to/pending.json [REASON='误识别']"; \
		exit 1; \
	fi
	$(HIT) queue-reject --file "$(FILE)" $(if $(REASON),--reason "$(REASON)")

browser-hit-install:
	cd $(AIFIOS_HOME)/skills/xhs-card && npm install

browser-hit-doctor:
	$(BROWSER_HIT_DOCTOR)

browser-hit-fixture-check:
	$(BROWSER_HIT_FIXTURE_CHECK)

browser-hit-collect:
	@if [ -z "$(PLATFORM)" ]; then \
		echo "用法: make browser-hit-collect PROJECT=... PLATFORM=xhs [KEYWORD=...] [URL=...]"; \
		exit 1; \
	fi
	$(BROWSER_HIT) --platform $(PLATFORM) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(URL),--url "$(URL)") $(if $(PROFILE),--profile "$(PROFILE)") $(if $(LIMIT),--limit $(LIMIT)) $(if $(MAX_SCROLLS),--max-scrolls $(MAX_SCROLLS)) $(if $(NO_WAIT),--no-wait) $(if $(HEADLESS),--headless) $(if $(DIAGNOSTICS),--diagnostics)

browser-hit-queue:
	@if [ -z "$(PLATFORM)" ]; then \
		echo "用法: make browser-hit-queue PROJECT=... PLATFORM=xhs [KEYWORD=...] [URL=...]"; \
		exit 1; \
	fi
	$(BROWSER_HIT) --queue --platform $(PLATFORM) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(URL),--url "$(URL)") $(if $(PROFILE),--profile "$(PROFILE)") $(if $(LIMIT),--limit $(LIMIT)) $(if $(MAX_SCROLLS),--max-scrolls $(MAX_SCROLLS)) $(if $(NO_WAIT),--no-wait) $(if $(HEADLESS),--headless) $(if $(DIAGNOSTICS),--diagnostics)

session-boot:
	$(SESSION) boot $(if $(FORCE),--force)

session-state:
	$(SESSION) state
