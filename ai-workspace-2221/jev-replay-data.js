// Static replay · selected Jev output from trusted task-results; never contains credentials.
window.NESSION_JEV_REPLAY = {
  "schemaVersion": 1,
  "model": "jev-1.13.0",
  "dataset": "archived-live-provider-observations",
  "recordedDate": "2026-10-23",
  "issue": 2221,
  "notes": "Readonly snapshots from task-results. Each row is a separate real HTTP model decision, not a continuous Nession business operation. State and candidates are reconstructed from the pinned Task source; outcomes and latency are from Task records. No key and no re-inference.",
  "suites": [
    {
      "id": "initial",
      "label": "首次真实验证",
      "detail": "初版即时动作匹配",
      "sourceSha": "ef3545b7437a105e98ec8cde5b5fe3905c78d831",
      "run": 39907128502,
      "taskId": "jev-live-2221-20261023",
      "variants": [
        {
          "id": "initial",
          "label": "初版提示词",
          "instruction": "你是 Nession 的 System One 路由器。只能选择当前 View 实际暴露的一个下一步动作，不得提前选择更深层的动作。若没有合适选项、目标不明确或请求需要未暴露动作，选择 none。用户修改表单字段时绝不能当成提交。"
        }
      ],
      "cases": [
        {
          "id": "root-goal",
          "view": "root",
          "utterance": "在北京节点创建一个名叫 dev-test 的 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力查看实际节点列表",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 能力查看已有会话列表",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:agents",
            "selected": "none",
            "hit": false,
            "confidence": 0.4,
            "elapsedMs": 283,
            "choice": "none",
            "inputTokens": 626,
            "outputTokens": 40,
            "requestHash": "354084b4534aa987",
            "expectedProbability": 0.19,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "root-session-list",
          "view": "root",
          "utterance": "看看已有 Session 列表",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力查看实际节点列表",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 能力查看已有会话列表",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:sessions",
            "selected": "entry:sessions",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 110,
            "choice": "c1",
            "inputTokens": 619,
            "outputTokens": 41,
            "requestHash": "8bada0fcaf5463da",
            "expectedProbability": 1,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "root-create-no-target",
          "view": "root",
          "utterance": "创建 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力查看实际节点列表",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 能力查看已有会话列表",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:agents",
            "selected": "none",
            "hit": false,
            "confidence": 0.55,
            "elapsedMs": 129,
            "choice": "none",
            "inputTokens": 612,
            "outputTokens": 40,
            "requestHash": "271860d34484a0f3",
            "expectedProbability": 0,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "agent-target-Beijing",
          "view": "agent.list",
          "utterance": "在北京节点创建 Session",
          "context": {
            "status": "loaded",
            "visibleAgentIds": [
              "agent-dev-01",
              "agent-bj-03",
              "agent-mac-02"
            ]
          },
          "actions": [
            {
              "id": "agent:select:agent-dev-01",
              "label": "选择 devbox",
              "actionId": "agent.select"
            },
            {
              "id": "agent:select:agent-bj-03",
              "label": "选择 北京节点",
              "actionId": "agent.select"
            },
            {
              "id": "agent:select:agent-mac-02",
              "label": "选择 macbook",
              "actionId": "agent.select"
            }
          ],
          "result": {
            "expected": "agent:select:agent-bj-03",
            "selected": "agent:select:agent-bj-03",
            "hit": true,
            "confidence": 0.93,
            "elapsedMs": 130,
            "choice": "c1",
            "inputTokens": 814,
            "outputTokens": 49,
            "requestHash": "664e9759ff1226dd",
            "expectedProbability": 0.95,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "agent-selected-create",
          "view": "agent.list",
          "utterance": "继续创建 Session",
          "context": {
            "selectedAgentId": "agent-bj-03",
            "status": "loaded"
          },
          "actions": [
            {
              "id": "agent:select:agent-bj-03",
              "label": "选择 北京节点",
              "actionId": "agent.select"
            },
            {
              "id": "agent:selected:create",
              "label": "在已选节点创建 Session",
              "actionId": "session.create.open"
            }
          ],
          "result": {
            "expected": "agent:selected:create",
            "selected": "agent:selected:create",
            "hit": true,
            "confidence": 0.95,
            "elapsedMs": 148,
            "choice": "c1",
            "inputTokens": 696,
            "outputTokens": 41,
            "requestHash": "0ef3b776d49b7552",
            "expectedProbability": 0.97,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "form-name-no-submit",
          "view": "session.create",
          "utterance": "名称改成 dev-test",
          "context": {
            "formValid": false,
            "dirty": true,
            "awaitingField": "name"
          },
          "actions": [
            {
              "id": "form:back",
              "label": "返回 Agent 列表",
              "actionId": "agent.list.back"
            }
          ],
          "result": {
            "expected": "none",
            "selected": "none",
            "hit": true,
            "confidence": 0.6,
            "elapsedMs": 111,
            "choice": "none",
            "inputTokens": 545,
            "outputTokens": 32,
            "requestHash": "43955b288e974154",
            "expectedProbability": 0.8,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "explicit-submit",
          "view": "session.create",
          "utterance": "确认提交这个 Session 创建表单",
          "context": {
            "formValid": true,
            "selectedAgentId": "agent-bj-03",
            "sessionName": "dev-test"
          },
          "actions": [
            {
              "id": "form:back",
              "label": "返回 Agent 列表",
              "actionId": "agent.list.back"
            },
            {
              "id": "form:submit",
              "label": "提交当前合法 Session 创建表单",
              "actionId": "session.create.submit"
            }
          ],
          "result": {
            "expected": "form:submit",
            "selected": "form:submit",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 156,
            "choice": "c1",
            "inputTokens": 646,
            "outputTokens": 41,
            "requestHash": "b8f6f7050438218d",
            "expectedProbability": 1,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "confirmed-open",
          "view": "session.create.result",
          "utterance": "打开刚创建的 Session",
          "context": {
            "confirmedSessionId": "agent-bj-03:dev-test"
          },
          "actions": [
            {
              "id": "form:back",
              "label": "返回 Agent 列表",
              "actionId": "agent.list.back"
            },
            {
              "id": "result:open",
              "label": "打开刚刚成功创建的 Session",
              "actionId": "session.open"
            }
          ],
          "result": {
            "expected": "result:open",
            "selected": "result:open",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 139,
            "choice": "c1",
            "inputTokens": 618,
            "outputTokens": 41,
            "requestHash": "735177c66b9afcbf",
            "expectedProbability": 1,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "filtered-ordinal",
          "view": "agent.list",
          "utterance": "选择第二个节点",
          "context": {
            "visibleAgentIds": [
              "agent-bj-03",
              "agent-mac-02"
            ],
            "filter": "dev|mac"
          },
          "actions": [
            {
              "id": "agent:select:agent-bj-03",
              "label": "选择 北京节点",
              "actionId": "agent.select"
            },
            {
              "id": "agent:select:agent-mac-02",
              "label": "选择 macbook",
              "actionId": "agent.select"
            }
          ],
          "result": {
            "expected": "agent:select:agent-mac-02",
            "selected": "agent:select:agent-mac-02",
            "hit": true,
            "confidence": 0.98,
            "elapsedMs": 102,
            "choice": "c1",
            "inputTokens": 706,
            "outputTokens": 41,
            "requestHash": "08cb46bbeec62a2e",
            "expectedProbability": 0.99,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "ambiguous-reference",
          "view": "agent.list",
          "utterance": "选择我之前说的那个节点",
          "context": {
            "visibleAgentIds": [
              "agent-bj-03",
              "agent-dev-01"
            ],
            "selection": null
          },
          "actions": [
            {
              "id": "agent:select:agent-bj-03",
              "label": "选择 北京节点",
              "actionId": "agent.select"
            },
            {
              "id": "agent:select:agent-dev-01",
              "label": "选择 devbox",
              "actionId": "agent.select"
            }
          ],
          "result": {
            "expected": "none",
            "selected": "none",
            "hit": true,
            "confidence": 0.92,
            "elapsedMs": 152,
            "choice": "none",
            "inputTokens": 702,
            "outputTokens": 40,
            "requestHash": "51e0e835d316db67",
            "expectedProbability": 0.95,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "offline-target",
          "view": "agent.list",
          "utterance": "在离线的 Tokyo 节点创建 Session",
          "context": {
            "selectedAgentId": "agent-tokyo-04",
            "selectedStatus": "offline"
          },
          "actions": [
            {
              "id": "agent:select:agent-tokyo-04",
              "label": "选择 Tokyo 节点（离线）",
              "actionId": "agent.select"
            }
          ],
          "result": {
            "expected": "none",
            "selected": "none",
            "hit": true,
            "confidence": 0.54,
            "elapsedMs": 99,
            "choice": "none",
            "inputTokens": 609,
            "outputTokens": 32,
            "requestHash": "e8a2c527a61b4bae",
            "expectedProbability": 0.77,
            "resolvedModel": "jev-1.13.0"
          }
        },
        {
          "id": "return-scene",
          "view": "session.list",
          "utterance": "回到之前的 Agent 场景",
          "context": {
            "activeSceneId": "scene-sessions"
          },
          "actions": [
            {
              "id": "nav:agent",
              "label": "返回已打开的 Agent Scene",
              "actionId": "scene.focus"
            },
            {
              "id": "entry:agents",
              "label": "重新进入 Agent 列表",
              "actionId": "agent.list.show"
            }
          ],
          "result": {
            "expected": "nav:agent",
            "selected": "nav:agent",
            "hit": true,
            "confidence": 0.56,
            "elapsedMs": 142,
            "choice": "c0",
            "inputTokens": 615,
            "outputTokens": 41,
            "requestHash": "1cbe14549e2fb196",
            "expectedProbability": 0.71,
            "resolvedModel": "jev-1.13.0"
          }
        }
      ]
    },
    {
      "id": "comparison",
      "label": "提示词 A/B 对照",
      "detail": "相同 5 个场景对比严格匹配与渐进推进",
      "sourceSha": "bcc0a4afd978ea0027bd626b4605194adfaf8fe8",
      "run": 39908609159,
      "taskId": "jev-goal-fsm-2221-20261023",
      "variants": [
        {
          "id": "baseline",
          "label": "严格匹配",
          "instruction": "只能选择当前 View 实际暴露的下一步动作，不得选择未来深层动作。若请求的动作尚未暴露、目标不明确或者当前候选不匹配，选 none。"
        },
        {
          "id": "progressive",
          "label": "渐进推进",
          "instruction": "用户说的是最终工作目标，它可能需要多个 View 才能实现。请选择当下已暴露的一个可以推进该目标的安全中间动作：可以先进入能力、发现或选择资源，再在新状态下选择下一个动作。绝不能选择未列出的未来动作。只有全部当前候选都不能合理推进目标、目标有歧义或必须等待数据时才选 none。"
        }
      ],
      "cases": [
        {
          "id": "root-specific",
          "view": "root",
          "utterance": "在北京节点创建一个名叫 dev-test 的 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，查看并选择节点",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表查看已有会话",
              "actionId": "session.list.show"
            }
          ],
          "variant": "baseline",
          "result": {
            "expected": "entry:agents",
            "selected": "none",
            "hit": false,
            "confidence": 0.33,
            "elapsedMs": 203,
            "tokens": 570
          }
        },
        {
          "id": "root-generic",
          "view": "root",
          "utterance": "创建 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，查看并选择节点",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表查看已有会话",
              "actionId": "session.list.show"
            }
          ],
          "variant": "baseline",
          "result": {
            "expected": "entry:agents",
            "selected": "none",
            "hit": false,
            "confidence": 0.45,
            "elapsedMs": 85,
            "tokens": 556
          }
        },
        {
          "id": "root-list",
          "view": "root",
          "utterance": "查看我有哪些 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，查看并选择节点",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表查看已有会话",
              "actionId": "session.list.show"
            }
          ],
          "variant": "baseline",
          "result": {
            "expected": "entry:sessions",
            "selected": "entry:sessions",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 68,
            "tokens": 562
          }
        },
        {
          "id": "root-irrelevant",
          "view": "root",
          "utterance": "帮我写一首秋天的诗",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，查看并选择节点",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表查看已有会话",
              "actionId": "session.list.show"
            }
          ],
          "variant": "baseline",
          "result": {
            "expected": "none",
            "selected": "none",
            "hit": true,
            "confidence": 0.51,
            "elapsedMs": 84,
            "tokens": 563
          }
        },
        {
          "id": "agent-selected",
          "view": "agent.list.selected",
          "utterance": "在这个节点创建 Session",
          "context": {},
          "actions": [
            {
              "id": "view:select",
              "label": "选择已显示的北京节点",
              "actionId": "agent.select"
            },
            {
              "id": "view:create",
              "label": "在当前已选择 Agent 上打开 SessionCreate 表单",
              "actionId": "session.create.open"
            }
          ],
          "variant": "baseline",
          "result": {
            "expected": "view:create",
            "selected": "view:create",
            "hit": true,
            "confidence": 0.95,
            "elapsedMs": 101,
            "tokens": 574
          }
        },
        {
          "id": "root-specific",
          "view": "root",
          "utterance": "在北京节点创建一个名叫 dev-test 的 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，查看并选择节点",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表查看已有会话",
              "actionId": "session.list.show"
            }
          ],
          "variant": "progressive",
          "result": {
            "expected": "entry:agents",
            "selected": "entry:agents",
            "hit": true,
            "confidence": 0.92,
            "elapsedMs": 73,
            "tokens": 644
          }
        },
        {
          "id": "root-generic",
          "view": "root",
          "utterance": "创建 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，查看并选择节点",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表查看已有会话",
              "actionId": "session.list.show"
            }
          ],
          "variant": "progressive",
          "result": {
            "expected": "entry:agents",
            "selected": "entry:agents",
            "hit": true,
            "confidence": 0.49,
            "elapsedMs": 123,
            "tokens": 630
          }
        },
        {
          "id": "root-list",
          "view": "root",
          "utterance": "查看我有哪些 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，查看并选择节点",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表查看已有会话",
              "actionId": "session.list.show"
            }
          ],
          "variant": "progressive",
          "result": {
            "expected": "entry:sessions",
            "selected": "entry:sessions",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 58,
            "tokens": 635
          }
        },
        {
          "id": "root-irrelevant",
          "view": "root",
          "utterance": "帮我写一首秋天的诗",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，查看并选择节点",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表查看已有会话",
              "actionId": "session.list.show"
            }
          ],
          "variant": "progressive",
          "result": {
            "expected": "none",
            "selected": "entry:agents",
            "hit": false,
            "confidence": 0.89,
            "elapsedMs": 75,
            "tokens": 637
          }
        },
        {
          "id": "agent-selected",
          "view": "agent.list.selected",
          "utterance": "在这个节点创建 Session",
          "context": {},
          "actions": [
            {
              "id": "view:select",
              "label": "选择已显示的北京节点",
              "actionId": "agent.select"
            },
            {
              "id": "view:create",
              "label": "在当前已选择 Agent 上打开 SessionCreate 表单",
              "actionId": "session.create.open"
            }
          ],
          "variant": "progressive",
          "result": {
            "expected": "view:create",
            "selected": "view:create",
            "hit": true,
            "confidence": 0.74,
            "elapsedMs": 77,
            "tokens": 647
          }
        }
      ]
    },
    {
      "id": "relevance",
      "label": "语义相关性约束",
      "detail": "强调目标相关性，避免无关请求误进能力",
      "sourceSha": "093b34b5c8c7bb392741272f756f2f25e9ef4ba0",
      "run": 39908810295,
      "taskId": "jev-goal-relevance-2221-20261023",
      "variants": [
        {
          "id": "relevance",
          "label": "相关性约束",
          "instruction": "你控制 Nession 的渐进式工作界面。用户可能描述最终目标，需要先打开能力入口、加载资源或选择目标。请仅从当前暴露的选项选择一个“与目标有明确语义关系、能直接推进目标”的下一步；创建新 Session 应先进入 Agent 节点能力以选择节点。严禁选择未暴露的更深层动作，严禁自动提交业务变更。先判断用户目标是否属于所列能力或它们明确的前置操作；对于写诗、食谱、数学等与当前 Nession 能力无关的请求，必须选 none。不能仅因某个入口“或许有帮助”就选择它。"
        }
      ],
      "cases": [
        {
          "id": "create-Beijing",
          "view": "workspace.root",
          "utterance": "在北京节点创建一个名叫 dev-test 的 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:agents",
            "selected": "entry:agents",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 165
          }
        },
        {
          "id": "create-general",
          "view": "workspace.root",
          "utterance": "创建 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:agents",
            "selected": "entry:agents",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 71
          }
        },
        {
          "id": "create-Mac",
          "view": "workspace.root",
          "utterance": "在 Mac 节点上创建 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:agents",
            "selected": "entry:agents",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 90
          }
        },
        {
          "id": "list-sessions",
          "view": "workspace.root",
          "utterance": "查看现有的 Session",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:sessions",
            "selected": "entry:sessions",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 57
          }
        },
        {
          "id": "list-agents",
          "view": "workspace.root",
          "utterance": "查看所有 Agent 节点",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:agents",
            "selected": "entry:agents",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 65
          }
        },
        {
          "id": "nonsense-poem",
          "view": "workspace.root",
          "utterance": "写一首关于秋天的诗",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "none",
            "selected": "none",
            "hit": true,
            "confidence": 0.95,
            "elapsedMs": 58
          }
        },
        {
          "id": "nonsense-food",
          "view": "workspace.root",
          "utterance": "推荐一道周末晚餐菜谱",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "none",
            "selected": "none",
            "hit": true,
            "confidence": 0.98,
            "elapsedMs": 90
          }
        },
        {
          "id": "nonsense-math",
          "view": "workspace.root",
          "utterance": "解释一下勾股定理",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "none",
            "selected": "none",
            "hit": true,
            "confidence": 1,
            "elapsedMs": 61
          }
        },
        {
          "id": "ambiguous",
          "view": "workspace.root",
          "utterance": "我想处理一下事情",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "none",
            "selected": "none",
            "hit": true,
            "confidence": 0.7,
            "elapsedMs": 58
          }
        },
        {
          "id": "return-help",
          "view": "workspace.root",
          "utterance": "怎么查看我当前有哪些 Agent？",
          "context": {},
          "actions": [
            {
              "id": "entry:agents",
              "label": "进入 Agent 能力，发现并选择可用工作节点；只有进入此能力、选中节点后，才可以逐步使用该节点上的 Session 创建等操作。",
              "actionId": "agent.list.show"
            },
            {
              "id": "entry:sessions",
              "label": "进入 Session 列表，查看、选择或打开已有会话。",
              "actionId": "session.list.show"
            }
          ],
          "result": {
            "expected": "entry:agents",
            "selected": "entry:agents",
            "hit": true,
            "confidence": 0.88,
            "elapsedMs": 73
          }
        }
      ]
    }
  ]
};
