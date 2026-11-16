PROJECT ?= ~/ai-content-system
RUNTIME := python3 scripts/content_runtime.py --project $(PROJECT)
DIRECTOR := python3 scripts/content_pipeline.py --project $(PROJECT)
HIT := python3 scripts/hit_collector.py --project $(PROJECT)
BROWSER_HIT := node scripts/browser_hit_collector.mjs --project $(PROJECT)
BROWSER_HIT_DOCTOR := node scripts/browser_hit_doctor.mjs
BROWSER_HIT_FIXTURE_CHECK := node scripts/browser_hit_fixture_check.mjs
QUALITY := python3 scripts/quality_check.py --project $(PROJECT)
DELIVERY := python3 scripts/delivery_pack.py --project $(PROJECT)
DELIVERY_AUDIT := python3 scripts/delivery_audit.py --project $(PROJECT)
DBS_FUSION_APPLY := python3 scripts/dbs_fusion_apply.py --project $(PROJECT)

.PHONY: start guide onboard work cockpit init status next flow content-flow write read run runs run-create run-switch run-resume run-archive brain validate-file quality-check delivery-pack delivery-audit dbs-fusion-apply hit-init hit-add hit-import hit-list hit-report hit-queue-list hit-queue-import hit-queue-reject browser-hit-install browser-hit-doctor browser-hit-fixture-check browser-hit-collect browser-hit-queue session-boot session-guide session-route session-update session-state manifest-check runtime-contracts help

start:
	python3 scripts/session_manager.py --project $(PROJECT) start $(if $(INPUT),"$(INPUT)") $(if $(JSON),--json)

guide: start

onboard:
	python3 scripts/session_manager.py --project $(PROJECT) onboard $(if $(GOAL),--goal "$(GOAL)") $(if $(PLATFORMS),--platforms "$(PLATFORMS)") $(if $(OFFER),--offer "$(OFFER)") $(if $(TARGET),--target "$(TARGET)") $(if $(PRODUCT),--product "$(PRODUCT)") $(if $(JSON),--json)

work:
	python3 scripts/session_manager.py --project $(PROJECT) work $(if $(INPUT),"$(INPUT)") $(if $(JSON),--json)

cockpit: work

init:
	$(RUNTIME) init

status:
	$(DIRECTOR) $(if $(SLUG),--slug $(SLUG)) status

next:
	$(DIRECTOR) $(if $(SLUG),--slug $(SLUG)) next

flow:
	$(DIRECTOR) flow $(if $(INTAKE),--intake $(INTAKE)) $(if $(SLUG),--slug $(SLUG))

write:
	@if [ -z "$(STEP)" ] || [ -z "$(SLUG)" ] || [ -z "$(FILE)" ]; then \
		echo "用法: make write PROJECT=... STEP=intake SLUG=demo FILE=output.md"; \
		exit 1; \
	fi
	$(RUNTIME) write --step $(STEP) --slug $(SLUG) --content @$(FILE) $(if $(SOURCE),--source "$(SOURCE)")

read:
	@if [ -z "$(STEP)" ]; then \
		echo "用法: make read PROJECT=... STEP=intake"; \
		exit 1; \
	fi
	$(RUNTIME) read --step $(STEP) --latest $(if $(SLUG),--slug $(SLUG)) $(if $(SUMMARY),--summary)

brain:
	@if [ -z "$(FILE)" ]; then \
		echo "用法: make brain PROJECT=... FILE=insights.md CONTENT='...'"; \
		exit 1; \
	fi
	$(RUNTIME) brain --file $(FILE) --content "$(CONTENT)"

validate-file:
	@if [ -z "$(STEP)" ] || [ -z "$(FILE)" ]; then \
		echo "用法: make validate-file PROJECT=... STEP=intake FILE=path"; \
		exit 1; \
	fi
	$(RUNTIME) validate --step $(STEP) --file $(FILE)

help:
	@echo "content-runtime · Makefile"
	@echo "  make start PROJECT=~/ai-content-system [INPUT='我想写公众号']"
	@echo "  make onboard PROJECT=... PLATFORMS='公众号,小红书,视频号' OFFER='...' TARGET='...' PRODUCT='...'"
	@echo "  make work PROJECT=... [INPUT='继续']"
	@echo "  make init PROJECT=~/ai-content-system"
	@echo "  make status PROJECT=~/ai-content-system"
	@echo "  make next PROJECT=~/ai-content-system [SLUG=demo]"
	@echo "  make run-create PROJECT=... TOPIC='主题' [PLATFORMS='公众号,小红书,视频号']"
	@echo "  make run-switch PROJECT=... RUN_ID=..."
	@echo "  make run-resume PROJECT=... [RUN_ID=...]"
	@echo "  make run-archive PROJECT=... [RUN_ID=...]"
	@echo "  make quality-check PROJECT=... PLATFORM=wechat [FILE=...]"
	@echo "  make delivery-pack PROJECT=... [RUN_ID=...]"
	@echo "  make delivery-audit PROJECT=... [RUN_ID=...] [AUTO_PACK=1]"
	@echo "  make dbs-fusion-apply PROJECT=... [FILE=...] [SLUG=...] [DRY_RUN=1] [FORCE=1]"
	@echo "  make flow PROJECT=... [INTAKE=/path/to/intake.md] [SLUG=demo]"
	@echo "  make content-flow PROJECT=... [INTAKE=/path/to/intake.md] [SLUG=demo]"
	@echo "  make write PROJECT=... STEP=intake SLUG=demo FILE=output.md [SOURCE=...]"
	@echo "  make read PROJECT=... STEP=intake [SLUG=demo] [SUMMARY=1]"
	@echo "  make brain PROJECT=... FILE=insights.md CONTENT='...'"
	@echo "  make validate-file PROJECT=... STEP=intake FILE=..."
	@echo "  make runtime-contracts"
	@echo "  make hit-import PROJECT=... PLATFORM=xhs FILE=samples.json"
	@echo "  make hit-report PROJECT=... [PLATFORM=xhs] [KEYWORD=...]"
	@echo "  make browser-hit-install"
	@echo "  make browser-hit-doctor"
	@echo "  make browser-hit-fixture-check"
	@echo "  make browser-hit-collect PROJECT=... PLATFORM=xhs [KEYWORD=...]"
	@echo "  make browser-hit-queue PROJECT=... PLATFORM=xhs [KEYWORD=...]"

content-flow: flow

hit-init:
	$(HIT) init

hit-add:
	@if [ -z "$(PLATFORM)" ] || [ -z "$(TITLE)" ]; then \
		echo "用法: make hit-add PROJECT=... PLATFORM=xhs TITLE='标题' [LIKES=100]"; \
		exit 1; \
	fi
	$(HIT) add --platform $(PLATFORM) --title "$(TITLE)" $(if $(URL),--url "$(URL)") $(if $(AUTHOR),--author "$(AUTHOR)") $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(TOPIC),--topic "$(TOPIC)") $(if $(COVER_TEXT),--cover-text "$(COVER_TEXT)") $(if $(HOOK),--hook "$(HOOK)") $(if $(AUDIENCE_PAIN),--audience-pain "$(AUDIENCE_PAIN)") $(if $(COMMERCIAL_ANGLE),--commercial-angle "$(COMMERCIAL_ANGLE)") $(if $(WHY),--why-it-worked "$(WHY)") $(if $(TAGS),--tags "$(TAGS)") $(if $(READS),--reads $(READS)) $(if $(LIKES),--likes $(LIKES)) $(if $(COLLECTS),--collects $(COLLECTS)) $(if $(COMMENTS),--comments $(COMMENTS)) $(if $(SHARES),--shares $(SHARES)) $(if $(WOWS),--wows $(WOWS)) $(if $(RECOMMENDS),--recommends $(RECOMMENDS))

hit-import:
	@if [ -z "$(PLATFORM)" ] || [ -z "$(FILE)" ]; then \
		echo "用法: make hit-import PROJECT=... PLATFORM=xhs FILE=samples.json"; \
		exit 1; \
	fi
	$(HIT) import --platform $(PLATFORM) --file $(FILE) $(if $(FORMAT),--format $(FORMAT)) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(TOPIC),--topic "$(TOPIC)") $(if $(PREVIEW),--preview) $(if $(CONFIRM),--confirm)

hit-list:
	$(HIT) list $(if $(PLATFORM),--platform $(PLATFORM)) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(LIMIT),--limit $(LIMIT))

hit-report:
	$(HIT) report $(if $(PLATFORM),--platform $(PLATFORM)) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(LIMIT),--limit $(LIMIT))

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
	cd ../xhs-card && npm install

browser-hit-doctor:
	$(BROWSER_HIT_DOCTOR)

browser-hit-fixture-check:
	$(BROWSER_HIT_FIXTURE_CHECK)

browser-hit-collect:
	@if [ -z "$(PLATFORM)" ]; then \
		echo "用法: make browser-hit-collect PROJECT=... PLATFORM=xhs [KEYWORD=...]"; \
		exit 1; \
	fi
	$(BROWSER_HIT) --platform $(PLATFORM) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(URL),--url "$(URL)") $(if $(PROFILE),--profile "$(PROFILE)") $(if $(LIMIT),--limit $(LIMIT)) $(if $(MAX_SCROLLS),--max-scrolls $(MAX_SCROLLS)) $(if $(NO_WAIT),--no-wait) $(if $(HEADLESS),--headless)

browser-hit-queue:
	@if [ -z "$(PLATFORM)" ]; then \
		echo "用法: make browser-hit-queue PROJECT=... PLATFORM=xhs [KEYWORD=...]"; \
		exit 1; \
	fi
	$(BROWSER_HIT) --queue --platform $(PLATFORM) $(if $(KEYWORD),--keyword "$(KEYWORD)") $(if $(URL),--url "$(URL)") $(if $(PROFILE),--profile "$(PROFILE)") $(if $(LIMIT),--limit $(LIMIT)) $(if $(MAX_SCROLLS),--max-scrolls $(MAX_SCROLLS)) $(if $(NO_WAIT),--no-wait) $(if $(HEADLESS),--headless)

session-boot:
	python3 scripts/session_manager.py --project $(PROJECT) boot $(if $(FORCE),--force)

session-guide:
	python3 scripts/session_manager.py --project $(PROJECT) guide $(if $(INPUT),"$(INPUT)") $(if $(JSON),--json)

session-route:
	@if [ -z "$(INPUT)" ]; then \
		echo "用法: make session-route PROJECT=... INPUT='帮我写获客稿'"; \
		exit 1; \
	fi
	python3 scripts/session_manager.py --project $(PROJECT) route "$(INPUT)"

session-update:
	@if [ -z "$(SECTION)" ] || [ -z "$(CONTENT)" ]; then \
		echo "用法: make session-update PROJECT=... SECTION=knowledge_log CONTENT='...'"; \
		exit 1; \
	fi
	python3 scripts/session_manager.py --project $(PROJECT) update --section $(SECTION) --content "$(CONTENT)" $(if $(REPLACE),--replace)

session-state:
	python3 scripts/session_manager.py --project $(PROJECT) state

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

test:
	python3 scripts/check_manifest.py
	python3 ../../scripts/check_runtime_contracts.py
	python3 -m pytest -q tests

manifest-check:
	python3 scripts/check_manifest.py

runtime-contracts:
	python3 ../../scripts/check_runtime_contracts.py
