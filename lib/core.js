'use strict'

const {protocol, sysmsg} = require('tera-data-parser'),
	Long = require('long'),
	Vec3 = require('vec3'),
	Command = require('command'),
	Player = require('./player'),
	Ping = require('./ping'),
	AbnormalityPrediction = require('./abnormalities'),
	settings = require('../settings'),
	skills = require('../config/skills'),
	silence = require('../config/silence').reduce((map, value) => { // Convert array to object for fast lookup
		map[value] = true
		return map
	}, {})

const INTERRUPT_TYPES = {
	retaliate: 5,
	lockonCast: 36
}

const Flags = {
	Skill: 0x04000000,
	CC: 0x08000000,
	NPC: 0x40000000
}

module.exports = function SkillPredictionCore(dispatch) {
	const command = Command(dispatch),
		player = Player(dispatch),
		ping = Ping(dispatch),
		abnormality = AbnormalityPrediction(dispatch)

	if(settings.DEBUG) require('./debug')(dispatch).toggle() // Lazy implementation for now

	let sending = false,
		skillsCache = null,
		vehicleEx = null,
		currentGlyphs = null,
		alive = false,
		inCombat = false,
		inventoryHook = null,
		inventory = null,
		equippedWeapon = false,
		partyMembers = null,
		delayNext = 0,
		delayNextTimeout = null,
		actionNumber = 0x80000000,
		myPosition = null,
		lastStartTime = 0,
		lastStartPos = null,
		lastEndPosition = null,
		oopsPosition = null,
		currentAction = null,
		serverAction = null,
		serverConfirmedAction = false,
		queuedNotifyLocation = [],
		clientProjectileId = 0,
		clientProjectiles = {},
		clientProjectileHits = [],
		serverProjectiles = {},
		storedCharge = 0,
		lastEndSkill = 0,
		lastEndType = 0,
		lastEndedId = 0,
		serverTimeout = null,
		effectsTimeouts = [],
		stageEnd = null,
		stageEndTime = 0,
		stageEndTimeout = null,
		debugActionTime = 0

	dispatch.hook('S_LOGIN', 'raw', {order: 100, filter: {fake: null}}, event => {
		skillsCache = {}
		hookInventory()
	})

	dispatch.hook('S_LOAD_TOPO', 'raw', () => {
		vehicleEx = null
		currentAction = null
		serverAction = null
		lastEndSkill = 0
		lastEndType = 0
		lastEndedId = 0
		sendActionEnd(37)
	})

	dispatch.hook('S_CREST_INFO', 2, event => {
		currentGlyphs = {}

		for(let c of event.crests)
			currentGlyphs[c.id] = c.enable
	})

	dispatch.hook('S_CREST_APPLY', 2, event => {
		if(settings.DEBUG_GLYPH) console.log('Glyph', event.id, event.enabled)

		currentGlyphs[event.id] = event.enable
	})

	dispatch.hook('S_SPAWN_ME', 2, {order: 100, filter: {fake: null}}, event => {
		updatePosition(event)
		alive = event.alive
	})

	dispatch.hook('S_CREATURE_LIFE', 2, event => {
		if(isMe(event.gameId)) {
			alive = event.alive

			if(!alive) {
				clearStage()
				oopsPosition = currentAction = serverAction = null
			}
		}
	})

	dispatch.hook('S_USER_STATUS', 1, event => {
		if(event.target.equals(player.gameId)) {
			inCombat = event.status == 1

			if(!inCombat) hookInventory()
			else if(!inventory && inventoryHook) {
				dispatch.unhook(inventoryHook)
				inventoryHook = null
			}
		}
	})

	function hookInventory() {
		if(!inventoryHook) inventoryHook = dispatch.hook('S_INVEN', 12, event => {
			inventory = event.first ? event.items : inventory.concat(event.items)

			if(!event.more) {
				equippedWeapon = false

				for(let item of inventory)
					if(item.slot == 1) {
						equippedWeapon = true
						break
					}

				inventory = null

				if(inCombat) {
					dispatch.unhook(inventoryHook)
					inventoryHook = null
				}
			}
		})
	}

	dispatch.hook('S_PARTY_MEMBER_LIST', 1, event => {
		partyMembers = []

		for(let member of event.members)
			if(!member.cID.equals(player.gameId))
				partyMembers.push(member.cID)
	})

	dispatch.hook('S_LEAVE_PARTY', () => { partyMembers = null })

	dispatch.hook('S_MOUNT_VEHICLE_EX', 1, event => {
		if(event.target.equals(player.gameId)) vehicleEx = event.vehicle
	})

	dispatch.hook('S_UNMOUNT_VEHICLE_EX', 1, event => {
		if(event.target.equals(player.gameId)) vehicleEx = null
	})

	dispatch.hook('C_PLAYER_LOCATION', 3, {order: 10, filter: {fake: null}}, event => {
		if(settings.DEBUG_LOC) console.log('Location %d %d (%d %d %d %s) > (%d %d %d)', event.type, event.speed, Math.round(event.loc.x), Math.round(event.loc.y), Math.round(event.loc.z), degrees(event.w), Math.round(event.dest.x), Math.round(event.dest.y), Math.round(event.dest.z))

		if(currentAction) {
			const info = skillInfo(currentAction.skill)

			if(info && (info.distance || info.type == 'dynamicDistance')) return false
		}

		// This is not correct, but the midpoint location seems to be "close enough" for the client to not teleport the player
		updatePosition({loc: event.loc.addN(event.dest).scale(0.5), w: event.w})
	})

	for(let packet of [
		['C_NOTIFY_LOCATION_IN_ACTION', 2],
		['C_NOTIFY_LOCATION_IN_DASH', 2]
	])
		dispatch.hook(...packet, notifyLocation.bind(null, ...packet))

	function notifyLocation(type, version, event) {
		if(settings.DEBUG_LOC) console.log('-> %s %s %d (%d %d %d %s)', type, skillId(event.skill), event.stage, Math.round(event.loc.x), Math.round(event.loc.y), Math.round(event.loc.z), degrees(event.w))

		updatePosition(event, true)

		const info = skillInfo(event.skill)
		// The server rejects and logs packets with an incorrect skill, so if a skill has multiple possible IDs then we wait for a response
		if(info && (info.chains || info.hasChains))
			if(serverConfirmedAction) {
				if(!serverAction) return false
				else if(event.skill !== serverAction.skill) {
					event.skill = serverAction.skill
					return true
				}
			}
			else {
				queuedNotifyLocation.push([type, version, event])
				return false
			}
	}

	function dequeueNotifyLocation(skill) {
		if(queuedNotifyLocation.length) {
			if(skill)
				for(let [type, version, event] of queuedNotifyLocation) {
					event.skill = skill
					dispatch.toServer(type, version, event)
				}

			queuedNotifyLocation = []
		}
	}

	for(let packet of [
			['C_START_SKILL', 4],
			['C_START_TARGETED_SKILL', 4],
			['C_START_COMBO_INSTANT_SKILL', 2],
			['C_START_INSTANCE_SKILL', 3],
			['C_START_INSTANCE_SKILL_EX', 3],
			['C_PRESS_SKILL', 2],
			['C_NOTIMELINE_SKILL', 1]
		])
		dispatch.hook(packet[0], 'raw', {order: -10, filter: {fake: null}}, startSkill.bind(null, ...packet))

	function startSkill(type, version, code, data) {
		if(sending) return

		const event = protocol.parse(dispatch.base.protocolVersion, type, version, data = Buffer.from(data)),
			info = skillInfo(event.skill)

		let delay = 0

		if(delayNext && Date.now() <= stageEndTime) {
			delay = delayNext

			if(info && !info.noRetry && settings.SKILL_RETRY_COUNT) {
				delay -= settings.SKILL_RETRY_JITTERCOMP

				if(delay < 0) delay = 0
			}
		}

		if(settings.DEBUG) {
			const strs = ['->', type, skillId(event.skill)]

			if(type == 'C_START_SKILL') strs.push(...[event.unk ? 1 : 0, event.moving ? 1 : 0, event.continue ? 1 : 0])
			if(type == 'C_PRESS_SKILL') strs.push(event.press)
			else if(type == 'C_START_TARGETED_SKILL') {
				const tmp = []

				for(let e of event.targets) tmp.push([e.id.toString(), e.unk].join(' '))

				strs.push('[' + tmp.join(', ') + ']')
			}

			if(settings.DEBUG_LOC) {
				strs.push(...[degrees(event.w), '(' + Math.round(event.x), Math.round(event.y), Math.round(event.z) + ')'])

				if(type == 'C_START_SKILL' || type == 'C_START_TARGETED_SKILL' || type == 'C_START_INSTANCE_SKILL_EX')
					strs.push(...['>', '(' + Math.round(event.toX), Math.round(event.toY), Math.round(event.toZ) + ')'])
			}

			if(delay) strs.push('DELAY=' + delay)

			debug(strs.join(' '))
		}

		clearTimeout(delayNextTimeout)

		if(delay) {
			delayNextTimeout = setTimeout(handleStartSkill, delay, type, event, info, data, true)
			return false
		}

		return handleStartSkill(type, event, info, data)
	}

	function handleStartSkill(type, event, info, data, send) {
		serverConfirmedAction = false
		dequeueNotifyLocation()
		delayNext = 0

		const specialLoc = !!event.dest

		if(!info) {
			if(type != 'C_PRESS_SKILL' || event.press)
				// Sometimes invalid (if this skill can't be used, but we have no way of knowing that)
				if(type != 'C_NOTIMELINE_SKILL') updatePosition(event, false, specialLoc)

			if(send) toServerLocked(data)
			return
		}

		let skill = event.skill,
			skillBase = Math.floor((skill - 0x4000000) / 10000),
			interruptType = 0

		if(type == 'C_PRESS_SKILL' && !event.press) {
			if(currentAction && currentAction.skill == skill) {
				if(info.type == 'hold' || info.type == 'holdInfinite') {
					updatePosition(event)

					if(info.chainOnRelease) {
						sendActionEnd(11)

						info = skillInfo(skill = modifyChain(skill, info.chainOnRelease))
						if(!info) {
							if(send) toServerLocked(data)
							return
						}

						startAction({
							skill,
							info,
							stage: 0,
							speed: info.fixedSpeed || player.attackSpeed * (info.speed || 1)
						})
					}
					else if(info.length) {
						const length = lastStartTime + info.length - Date.now()
						if(length > 0) {
							stageEnd = sendActionEnd.bind(null, 51, info.distance)
							stageEndTime = Date.now() + length
							stageEndTimeout = setTimeout(stageEnd, length)
						}
						else sendActionEnd(51)
					}
					else sendActionEnd(10)
				}
				else if(info.type == 'charging') grantCharge(skill, info, currentAction.stage)
			}
			else if(info.type == 'grantCharge') grantCharge(skill, info, storedCharge)

			if(send) toServerLocked(data)
			return
		}

		if(!alive || abnormality.inMap(silence)) {
			sendCannotStartSkill(event.skill)
			return false
		}

		if(!equippedWeapon) {
			sendCannotStartSkill(event.skill)
			sendSystemMessage('SMT_BATTLE_SKILL_NEED_WEAPON')
			return false
		}

		if(currentAction) {
			if(currentAction.skill & Flags.CC && (currentAction.skill & 0xffffff !== player.templateId * 100 + 2 || info.type !== 'retaliate')) {
				sendCannotStartSkill(event.skill)
				return false
			}

			if(info.checkReset && currentAction.skill === skill && !currentAction.reset) {
				sendCannotStartSkill(event.skill)
				return false
			}

			const currentSkill = currentAction.skill - 0x4000000,
				currentSkillBase = Math.floor(currentSkill / 10000),
				currentSkillSub = currentSkill % 100

			// 6190XXXX = Pushback(?) - TODO: reproduce and log flags
			if(currentSkillBase == 6190) {
				sendCannotStartSkill(event.skill)
				return false
			}

			// Some skills are bugged clientside and can interrupt the wrong skills, so they need to be flagged manually
			if(info.noInterrupt && (info.noInterrupt.includes(currentSkillBase) || info.noInterrupt.includes(currentSkillBase + '-' + currentSkillSub))) {
				let canInterrupt = false

				if(info.interruptibleWithAbnormal)
					for(let abnormal in info.interruptibleWithAbnormal)
						if(abnormality.exists(abnormal) && currentSkillBase == info.interruptibleWithAbnormal[abnormal])
							canInterrupt = true

				if(!canInterrupt) {
					sendCannotStartSkill(event.skill)
					return false
				}
			}

			let chain = get(info, 'chains', currentSkillBase + '-' + currentSkillSub)

			if(chain === undefined) chain = get(info, 'chains', currentSkillBase)

			if(chain !== undefined) {
				if(chain === null) {
					updatePosition(event, false, specialLoc)
					sendActionEnd(4)
					if(send) toServerLocked(data)
					return
				}

				skill = modifyChain(skill, chain)
				interruptType = INTERRUPT_TYPES[info.type] || 4
			}
			else interruptType = INTERRUPT_TYPES[info.type] || 6

			if(info.type == 'storeCharge') storedCharge = currentAction.stage
		}

		if(info.onlyDefenceSuccess)
			if(currentAction && currentAction.defendSuccess) interruptType = 3
			else {
				sendCannotStartSkill(event.skill)
				sendSystemMessage('SMT_SKILL_ONLY_DEFENCE_SUCCESS')
				return false
			}

		if(info.onlyTarget && event.targets[0].id.equals(0)) {
			sendCannotStartSkill(event.skill)
			return false
		}

		// Skill override (chain)
		if(skill != event.skill) {
			info = skillInfo(skill)
			if(!info) {
				if(type != 'C_NOTIMELINE_SKILL') updatePosition(event, false, specialLoc)

				if(send) toServerLocked(data)
				return
			}
		}

		// TODO: System Message
		if(info.requiredBuff) {
			if(Array.isArray(info.requiredBuff)) {
				let found = false

				for(let buff of info.requiredBuff)
					if(abnormality.exists(buff)) {
						found = true
						break
					}

				if(!found) {
					sendCannotStartSkill(event.skill)
					return false
				}
			}
			else if(!abnormality.exists(info.requiredBuff)) {
				sendCannotStartSkill(event.skill)
				return false
			}
		}

		if(type != 'C_NOTIMELINE_SKILL') updatePosition(event, false, specialLoc)
		lastStartPos = myPosition

		let abnormalSpeed = 1,
			chargeSpeed = 0,
			distanceMult = 1

		if(info.abnormals)
			for(let id in info.abnormals)
				if(abnormality.exists(id)) {
					const abnormal = info.abnormals[id]

					if(abnormal.speed) abnormalSpeed *= abnormal.speed
					if(abnormal.chargeSpeed) chargeSpeed += abnormal.chargeSpeed
					if(abnormal.chain) skill = modifyChain(skill, abnormal.chain)
					if(abnormal.skill) skill = 0x4000000 + abnormal.skill
				}

		// Skill override (abnormal)
		if(skill != event.skill) {
			info = skillInfo(skill)
			if(!info) {
				if(send) toServerLocked(data)
				return
			}
		}

		if(interruptType) event.continue ? clearStage() : sendActionEnd(interruptType)

		// Finish calculations and send the final skill
		let speed = info.fixedSpeed || player.attackSpeed * (info.speed || 1) * abnormalSpeed,
			movement = null,
			stamina = info.stamina

		if(info.glyphs)
			for(let id in info.glyphs)
				if(currentGlyphs[id]) {
					const glyph = info.glyphs[id]

					if(glyph.speed) speed *= glyph.speed
					if(glyph.chargeSpeed) chargeSpeed += glyph.chargeSpeed
					if(glyph.movement) movement = glyph.movement
					if(glyph.distance) distanceMult *= glyph.distance
					if(glyph.stamina) stamina += glyph.stamina
				}

		if(stamina) {
			if(player.stamina < stamina) {
				sendCannotStartSkill(event.skill)
				//dispatch.toClient('S_SYSTEM_MESSAGE', 1, { message: '@' + sysmsg.map.name['SMT_BATTLE_SKILL_FAIL_LOW_STAMINA'] })
				return false
			}

			if(info.instantStamina) player.stamina -= stamina
		}

		startAction({
			skill,
			info,
			stage: 0,
			speed,
			chargeSpeed,
			movement,
			moving: type == 'C_START_SKILL' && event.moving == 1,
			distanceMult,
			targetLoc: event.dest
		})

		if(send) toServerLocked(data)

		// Normally the user can press the skill button again if it doesn't go off
		// However, once the animation starts this is no longer possible, so instead we simulate retrying each skill
		if(!info.noRetry)
			retry(() => {
				if((settings.SKILL_RETRY_ALWAYS && type != 'C_PRESS_SKILL') || currentAction && currentAction.skill == skill) return toServerLocked(data)
				return false
			})
	}

	function toServerLocked(...args) {
		sending = true
		const success = dispatch.toServer(...args)
		sending = false

		return success
	}

	dispatch.hook('C_CANCEL_SKILL', 1, event => {
		if(currentAction) {
			const info = skillInfo(currentAction.skill) // event.skill can be wrong, so use the known current skill instead
			if(info && info.type == 'lockon') sendActionEnd(event.type)
		}
	})

	// This packet is sent *before* S_ACTION_STAGE, so we should have plenty of time to check if the skill reset or not before the user uses it again
	dispatch.hook('S_CREST_MESSAGE', 2, event => {
		if(event.type === 6 && currentAction && event.skill === currentAction.skill - Flags.Skill)
			currentAction.reset = true
	})

	dispatch.hook('S_ACTION_STAGE', 4, event => {
		if(isMe(event.gameId)) {
			if(settings.DEBUG) {
				const duration = Date.now() - debugActionTime,
					strs = [skillInfo(event.skill) ? '<X' : '<-', 'S_ACTION_STAGE', skillId(event.skill), event.stage, decimal(event.speed, 3) + 'x']

				if(settings.DEBUG_LOC) strs.push(...[degrees(event.w), '(' + Math.round(event.loc.x), Math.round(event.loc.y), Math.round(event.loc.z) + ')'])

				strs.push(...[event.unk1, event.unk2, event.dest.toString(), event.target.toNumber() ? 1 : 0])

				if(serverAction)
					strs.push(...[
						decimal(serverAction.loc.dist2D(event.loc), 3) + 'u',
						duration + 'ms',
						'(' + Math.round(duration * serverAction.speed) + 'ms)'
					])

				if(event.movement.length) {
					const movement = []

					for(let e of event.movement)
						movement.push(e.duration + ' ' + e.speed + ' ' + e.unk + ' ' + e.distance)

					strs.push('(' + movement.join(', ') + ')')
				}

				debug(strs.join(' '))
				debugActionTime = Date.now()
			}

			const info = skillInfo(event.skill)
			if(info) {
				if(currentAction && (event.skill == currentAction.skill || Math.floor((event.skill - 0x4000000) / 10000) == Math.floor((currentAction.skill - 0x4000000) / 10000)) && event.stage == currentAction.stage) {
					clearTimeout(serverTimeout)
					serverConfirmedAction = true
					dequeueNotifyLocation(event.skill)

					if(settings.JITTER_COMPENSATION && event.stage == 0) {
						const delay = Date.now() - lastStartTime - ping.min

						if(delay > 0 && delay < 1000) {
							delayNext = delay

							if(stageEnd) {
								stageEndTime += delay
								refreshStageEnd()
							}
						}
					}
				}

				if(info.forceClip && event.movement.length) {
					let distance = 0
					for(let m of event.movement) distance += m.distance

					if(info.distance < 0) distance = -distance

					oopsPosition = applyDistance(lastStartPos, distance)

					if(!currentAction || currentAction.skill != event.skill) sendInstantMove(oopsPosition)
				}

				// If the server sends 2 S_ACTION_STAGE in a row without a S_ACTION_END between them and the last one is an emulated skill,
				// this stops your character from being stuck in the first animation (although slight desync will occur)
				// TODO: verify (serverAction == currentAction) is correct - looks like a typo
				if(serverAction && serverAction == currentAction && !skillInfo(currentAction.skill)) sendActionEnd(6)

				serverAction = event
				return false
			}

			serverAction = event

			if(event.id == lastEndedId) return false

			if(currentAction && skillInfo(currentAction.skill)) sendActionEnd(lastEndSkill == currentAction.skill ? lastEndType || 6 : 6)

			currentAction = event
			updatePosition()
		}
	})

	dispatch.hook('S_GRANT_SKILL', 1, event => skillInfo(modifyChain(event.skill, 0)) ? false : undefined)

	dispatch.hook('S_INSTANT_DASH', 3, event => {
		if(isMe(event.gameId)) {
			if(settings.DEBUG) {
				const duration = Date.now() - debugActionTime,
					strs = [(serverAction && skillInfo(serverAction.skill)) ? '<X' : '<-', 'S_INSTANT_DASH', event.unk1, event.unk2, event.unk3]

				if(settings.DEBUG_LOC) strs.push(...[degrees(event.w), '(' + Math.round(event.loc.x), Math.round(event.loc.y), Math.round(event.loc.z) + ')'])

				strs.push(...[
					decimal(serverAction.loc.dist2D(event.loc), 3) + 'u',
					duration + 'ms',
					'(' + Math.round(duration * serverAction.speed) + 'ms)'
				])

				debug(strs.join(' '))
			}

			if(serverAction && skillInfo(serverAction.skill)) return false
		}
	})

	dispatch.hook('S_INSTANT_MOVE', 3, event => {
		if(isMe(event.gameId)) {
			if(settings.DEBUG) {
				const duration = Date.now() - debugActionTime,
					strs = ['<- S_INSTANT_MOVE']

				if(settings.DEBUG_LOC) strs.push(...[degrees(event.w), '(' + Math.round(event.loc.x), Math.round(event.loc.y), Math.round(event.loc.z) + ')'])

				strs.push(...[
					decimal(serverAction.loc.dist2D(event.loc), 3) + 'u',
					duration + 'ms',
					'(' + Math.round(duration * serverAction.speed) + 'ms)'
				])

				debug(strs.join(' '))
			}

			updatePosition(event, true)

			const info = serverAction && skillInfo(serverAction.skill)

			if(info && info.type == 'teleport' && currentAction && currentAction.skill != serverAction.skill)
				oopsPosition = myPosition
		}
	})

	dispatch.hook('S_ACTION_END', 3, event => {
		if(isMe(event.gameId)) {
			if(settings.DEBUG) {
				const duration = Date.now() - debugActionTime,
					strs = [(event.id == lastEndedId || skillInfo(event.skill)) ? '<X' : '<-', 'S_ACTION_END', skillId(event.skill), event.type]

				if(settings.DEBUG_LOC) strs.push(...[degrees(event.w), '(' + Math.round(event.loc.x), Math.round(event.loc.y), Math.round(event.loc.z) + ')'])

				if(serverAction)
					strs.push(...[
						decimal(serverAction.loc.dist2D(event.loc), 3) + 'u',
						duration + 'ms',
						'(' + Math.round(duration * serverAction.speed) + 'ms)'
					])
				else strs.push('???')

				debug(strs.join(' '))
			}

			serverAction = null
			lastEndSkill = event.skill
			lastEndType = event.type

			if(event.id == lastEndedId) {
				lastEndedId = 0
				return false
			}

			const info = skillInfo(event.skill)
			if(info) {
				if(info.type == 'dash')
					// If the skill ends early then there should be no significant error
					if(currentAction && event.skill == currentAction.skill) {
						updatePosition(event)
						sendActionEnd(event.type)
					}
					// Worst case scenario, teleport the player back if the error was large enough for the client to act on it
					else if(!lastEndPosition || lastEndPosition.loc.dist3D(event.loc) >= 100)
						sendInstantMove(event)

				// These end types are hard to emulate, so we use server response instead
				// This may cause bugs with very high ping and casting the same skill multiple times
				if(currentAction && event.skill == currentAction.skill && [2, 13, 25, 29, 43].includes(event.type))
					sendActionEnd(event.type)

				return false
			}

			if(!currentAction)
				console.log('[SkillPrediction] S_ACTION_END: currentAction is null', skillId(event.skill), event.id)
			else if(event.skill != currentAction.skill)
				console.log('[SkillPrediction] S_ACTION_END: skill mismatch', skillId(currentAction.skill), skillId(event.skill), currentAction.id, event.id)

			currentAction = null
		}
	})

	dispatch.hook('S_EACH_SKILL_RESULT', 5, event => {
		const ta = event.targetAction

		if(isMe(event.target) && ta.enable) {
			if(settings.DEBUG) {
				const duration = Date.now() - debugActionTime,
					strs = ['<- S_EACH_SKILL_RESULT.targetAction', skillId(ta.skill), ta.stage]

				if(settings.DEBUG_LOC) strs.push(...[degrees(ta.w), '(' + Math.round(ta.loc.x), Math.round(ta.loc.y), Math.round(ta.loc.z) + ')'])

				debug(strs.join(' '))
			}

			if(currentAction && skillInfo(currentAction.skill)) sendActionEnd(9)

			currentAction = serverAction = ta
			updatePosition()
		}
	})

	dispatch.hook('S_DEFEND_SUCCESS', 1, event => {
		if(isMe(event.cid))
			if(currentAction && currentAction.skill == serverAction.skill) currentAction.defendSuccess = true
			else if(settings.DEFEND_SUCCESS_STRICT || player.job != 10) return false
	})

	dispatch.hook('S_CANNOT_START_SKILL', 1, event => {
		if(skillInfo(event.skill, true)) {
			if(settings.SKILL_DELAY_ON_FAIL && settings.SKILL_RETRY_COUNT && currentAction && (!serverAction || currentAction.skill != serverAction.skill) && event.skill == currentAction.skill - 0x4000000)
				delayNext += settings.SKILL_RETRY_MS

			return false
		}
	})

	dispatch.hook('C_CAN_LOCKON_TARGET', 1, event => {
		const info = skillInfo(event.skill)
		if(info) {
			let ok = true

			if(info.partyOnly) {
				ok = false

				if(partyMembers) 
					for(let member of partyMembers)
						if(member.equals(event.target)) {
							ok = true
							break
						}
			}

			dispatch.toClient('S_CAN_LOCKON_TARGET', Object.assign({ok}, event))
		}
	})

	dispatch.hook('S_CAN_LOCKON_TARGET', 1, event => skillInfo(event.skill) ? false : undefined)

	if(settings.DEBUG_PROJECTILE) {
		dispatch.hook('S_SPAWN_PROJECTILE', 3, event => {
			if(!isMe(event.gameId)) return

			debug(`<- S_SPAWN_PROJECTILE ${skillId(event.skill)} ${event.unk1} ${event.loc.x} ${event.loc.y} ${event.loc.z} ${event.dest.x} ${event.dest.y} ${event.dest.z} ${event.moving} ${event.speed} ${event.unk2} ${event.unk3} ${event.w}`)

			if(skillInfo(event.skill)) {
				serverProjectiles[event.id.toString()] = event.skill
				return false
			}
		})

		dispatch.hook('S_DESPAWN_PROJECTILE', 2, event => {
			debug(`<- S_DESPAWN_PROJECTILE ${event.unk1} ${event.unk2}`)

			const idStr = event.id.toString()
			if(serverProjectiles[idStr]) {
				delete serverProjectiles[idStr]
				return false
			}
		})

		dispatch.hook('S_START_USER_PROJECTILE', 5, event => {
			if(!isMe(event.gameId)) return

			debug(`<- S_START_USER_PROJECTILE ${skillId(event.skill, Flags.Skill)} ${event.loc.x} ${event.loc.y} ${event.loc.z} ${event.dest.x} ${event.dest.y} ${event.dest.z} ${event.speed} ${event.distance} ${event.curve}`)

			const info = skillInfo(event.skill, true)
			if(info) {
				serverProjectiles[event.id.toString()] = Flags.Skill + event.skill
				applyProjectileHits(event.id, Flags.Skill + event.skill)
				return false
			}
		})

		dispatch.hook('S_END_USER_PROJECTILE', 3, event => {
			debug(`<- S_END_USER_PROJECTILE ${event.unk1} ${event.unk2} ${event.target.toNumber() ? 1 : 0}`)

			const idStr = event.id.toString()
			if(serverProjectiles[idStr]) {
				delete serverProjectiles[idStr]
				return false
			}
		})

		dispatch.hook('C_HIT_USER_PROJECTILE', 4, event => {
			debug(`-> C_HIT_USER_PROJECTILE ${event.targets.length} ${event.end}`)

			const idStr = event.id.toString(),
				skill = clientProjectiles[idStr]

			if(skill) {
				// Your own projectiles can hit you while moving, in which case we ignore this packet
				if(event.targets.length === 1 && event.targets[0].gameId.equals(player.gameId)) return false

				if(event.end || skillInfo(skill).explodeOnHit)
					removeProjectile(event.id, true, event.targets.length ? event.targets[0].gameId : true)

				for(let id in serverProjectiles)
					if(serverProjectiles[id] === skill) {
						event.id = Long.fromString(id, true)
						return true
					}

				clientProjectileHits.push(Object.assign(event, {
					skill,
					time: Date.now()
				}))
				return false
			}
		})

		function applyProjectileHits(id, skill) {
			// Garbage collect expired hits
			for(let i = 0, expiry = Date.now() - getServerTimeout(); i < clientProjectileHits.length; i++)
				if(clientProjectileHits[i].time <= expiry)
					clientProjectileHits.splice(i--, 1)

			for(let i = 0; i < clientProjectileHits.length; i++) {
				const event = clientProjectileHits[i]

				if(event.skill === skill) {
					clientProjectileHits.splice(i--, 1)

					event.id = id
					dispatch.toServer('C_HIT_USER_PROJECTILE', 4, event)

					if(event.end) {
						delete serverProjectiles[id.toString()]
						return
					}
				}
			}
		}
	}

	function startAction(opts) {
		const info = opts.info

		if(info.consumeAbnormal)
			if(Array.isArray(info.consumeAbnormal))
				for(let id of info.consumeAbnormal)
					abnormality.remove(id)
			else
				abnormality.remove(info.consumeAbnormal)

		sendActionStage(opts)

		if(info.type === 'dash' || info.projectiles) {
			opts.pos = Object.assign({}, myPosition)
			effectsTimeouts.push(setTimeout(sendActionEffects, 25, opts)) // Emulate server tick delay
		}

		if(info.triggerAbnormal)
			for(let id in info.triggerAbnormal) {
				const abnormal = info.triggerAbnormal[id]

				if(Array.isArray(abnormal))
					abnormality.add(id, abnormal[0], abnormal[1])
				else
					abnormality.add(id, abnormal, 1)
			}

		lastStartTime = Date.now()
	}

	function sendActionStage(opts) {
		clearTimeout(serverTimeout)

		opts.stage = opts.stage || 0
		opts.distanceMult = opts.distanceMult || 1

		movePlayer(opts.distance * opts.distanceMult)

		const info = opts.info,
			multiStage = Array.isArray(info.length)

		let movement = opts.movement

		if(multiStage)
			movement = movement && movement[opts.stage] || !opts.moving && get(info, 'inPlace', 'movement', opts.stage) || get(info, 'movement', opts.stage) || []
		else
			movement = movement || !opts.moving && get(info, 'inPlace', 'movement') || info.movement || []

		dispatch.toClient('S_ACTION_STAGE', 4, currentAction = {
			gameId: myChar(),
			loc: myPosition.loc,
			w: myPosition.w,
			templateId: player.templateId,
			skill: opts.skill,
			stage: opts.stage,
			speed: info.type == 'charging' ? 1 : opts.speed,
			id: actionNumber,
			unk1: 1,
			unk2: false,
			dest: undefined,
			target: 0,
			movement
		})

		opts.distance = (multiStage ? get(info, 'distance', opts.stage) : info.distance) || 0
		stageEnd = null

		const speed = opts.speed + (info.type == 'charging' ? opts.chargeSpeed : 0)

		let noTimeout = false

		if(serverAction && (serverAction.skill == currentAction.skill || Math.floor((serverAction.skill - 0x4000000) / 10000) == Math.floor((currentAction.skill - 0x4000000) / 10000)) && serverAction.stage == currentAction.stage)
			noTimeout = true

		switch(info.type) {
			case 'dynamicDistance':
				opts.distance = myPosition.loc.dist2D(opts.targetLoc)
				break
			case 'teleport':
				if(opts.stage != info.teleportStage) break

				opts.distance = Math.min(opts.distance, Math.max(0, myPosition.loc.dist2D(opts.targetLoc) - 15)) // Client is approx. 15 units off
				applyDistance(myPosition, opts.distance)
				myPosition.loc.z = opts.targetLoc.z
				sendInstantMove()
				opts.distance = 0
				break
			case 'charging':
				if(opts.stage == 0 || opts.stage < info.length.length) break

				if(info.autoRelease !== undefined) {
					stageEnd = () => {
						toServerLocked('C_PRESS_SKILL', 2, {
							skill: opts.skill,
							press: false,
							loc: myPosition.loc,
							w: myPosition.w
						})
						grantCharge(opts.skill, info, opts.stage)
					}

					if(info.autoRelease === 0) {
						stageEnd()
						stageEnd = null
					}
					else stageEndTimeout = setTimeout(stageEnd, Math.round(info.autoRelease / speed))
				}
			case 'holdInfinite':
				if(!noTimeout) serverTimeout = setTimeout(sendActionEnd, getServerTimeout(), 6)
				return
		}

		let length = Math.round((multiStage ? info.length[opts.stage] : info.length) / speed)

		if(!noTimeout) {
			let serverTimeoutTime = getServerTimeout()
			if(length > serverTimeoutTime) serverTimeout = setTimeout(sendActionEnd, serverTimeoutTime, 6)
		}

		if(multiStage) {
			if(!opts.moving) {
				let inPlaceDistance = get(info, 'inPlace', 'distance', opts.stage)

				if(inPlaceDistance !== undefined) opts.distance = inPlaceDistance
			}

			if(opts.stage + 1 < info.length.length) {
				opts.stage += 1
				stageEnd = sendActionStage.bind(null, opts)
				stageEndTime = Date.now() + length
				stageEndTimeout = setTimeout(stageEnd, length)
				return
			}
		}
		else
			if(!opts.moving) {
				const inPlaceDistance = get(info, 'inPlace', 'distance')

				if(inPlaceDistance !== undefined) opts.distance = inPlaceDistance
			}

		if(info.type == 'dash' && opts.distance) {
			const distance = lastStartPos.loc.dist2D(opts.targetLoc)

			if(distance < opts.distance) {
				length *= distance / opts.distance
				opts.distance = distance
			}
		}

		if(info.type == 'charging') {
			opts.stage += 1
			stageEnd = sendActionStage.bind(null, opts)
			stageEndTime = Date.now() + length
			stageEndTimeout = setTimeout(stageEnd, length)
			return
		}

		stageEnd = sendActionEnd.bind(null, info.type == 'dash' ? 39 : 0, opts.distance * opts.distanceMult)
		stageEndTime = Date.now() + length
		stageEndTimeout = setTimeout(stageEnd, length)
	}

	function sendActionEffects(opts) {
		const info = opts.info

		if(info.type === 'dash') sendInstantDash(opts.targetLoc)

		if(settings.DEBUG_PROJECTILE && info.projectiles)
			for(let chain of info.projectiles) {
				castProjectile({
					skill: modifyChain(opts.skill, chain),
					pos: opts.pos,
					targetLoc: opts.targetLoc
				})
			}
	}

	function clearEffects() {
		if(!effectsTimeouts.length) return
		for(let t of effectsTimeouts) clearTimeout(t)
		effectsTimeouts = []
	}

	function clearStage() {
		clearTimeout(serverTimeout)
		clearEffects()
		clearTimeout(stageEndTimeout)
	}

	function refreshStageEnd() {
		clearTimeout(stageEndTimeout)
		stageEndTimeout = setTimeout(stageEnd, stageEndTime - Date.now())
	}

	function grantCharge(skill, info, stage) {
		const levels = info.chargeLevels
		dispatch.toClient('S_GRANT_SKILL', 1, {skill: modifyChain(skill, levels ? levels[stage] : 10 + stage)})
	}

	function castProjectile(opts) {
		const info = skillInfo(opts.skill)

		if(info.delay) effectsTimeouts.push(setTimeout(addProjectile, info.delay, opts))
		else addProjectile(opts)
	}

	function addProjectile(opts) {
		const skill = opts.skill,
			info = skillInfo(skill)

		if(!info) return

		const id = new Long(0xffffffff, clientProjectileId = clientProjectileId + 1 >>> 0, true)

		clientProjectiles[id.toString()] = skill

		setTimeout(removeProjectile, 5000, id, info.type === 'userProjectile', true)

		if(info.type === 'userProjectile') {
			const {loc} = applyDistance({
				loc: opts.pos.loc.addN({z: 30}),
				w: opts.pos.w,
			}, 15)

			dispatch.toClient('S_START_USER_PROJECTILE', 5, {
				gameId: player.gameId,
				templateId: player.templateId,
				id,
				skill,
				loc,
				dest: opts.targetLoc,
				speed: info.flyingSpeed,
				distance: info.flyingDistance,
				curve: !!info.flyingDistance
			})
		}
	}

	function removeProjectile(id, user, explode) {
		delete clientProjectiles[id.toString()]

		if(user) {
			const target = typeof explode === 'object' ? explode : 0

			explode = !!explode

			dispatch.toClient('S_END_USER_PROJECTILE', 3, {
				id: id,
				unk1: explode && !target,
				unk2: explode,
				target
			})
		}
	}

	function sendInstantDash(dest) {
		dispatch.toClient('S_INSTANT_DASH', 3, {
			gameId: myChar(),
			target: 0,
			unk: 0,
			loc: dest,
			w: myPosition.w
		})
	}

	function sendInstantMove(event) {
		if(event) updatePosition(event)

		dispatch.toClient('S_INSTANT_MOVE', 3, {
			gameId: myChar(),
			loc: myPosition.loc,
			w: myPosition.w
		})
	}

	function sendActionEnd(type, distance) {
		clearStage()

		if(!currentAction) return

		if(settings.DEBUG) debug(['<* S_ACTION_END', skillId(currentAction.skill), type || 0, degrees(myPosition.w), (distance || 0) + 'u'].join(' '))

		if(oopsPosition && (settings.FORCE_CLIP_STRICT || !myPosition.action)) sendInstantMove(oopsPosition)
		else movePlayer(distance)

		dispatch.toClient('S_ACTION_END', 3, {
			gameId: myChar(),
			loc: myPosition.loc,
			w: myPosition.w,
			templateId: player.templateId,
			skill: currentAction.skill,
			type: type || 0,
			id: currentAction.id
		})

		if(currentAction.id == actionNumber) {
			const info = skillInfo(currentAction.skill)
			if(info) {
				if(info.consumeAbnormalEnd)
					if(Array.isArray(info.consumeAbnormalEnd))
						for(let id of info.consumeAbnormalEnd)
							abnormality.remove(id)
					else
						abnormality.remove(info.consumeAbnormalEnd)

				if(info.type == 'dash') lastEndPosition = myPosition
			}
		}
		else lastEndedId = currentAction.id

		actionNumber++
		if(actionNumber > 0xffffffff) actionNumber = 0x80000000

		oopsPosition = currentAction = null
	}

	function sendCannotStartSkill(skill) {
		dispatch.toClient('S_CANNOT_START_SKILL', 1, {skill})
	}

	function sendSystemMessage(type, vars) {
		let message = '@' + sysmsg.maps.get(dispatch.base.protocolVersion).name.get(type)

		for(let key in vars) message += '\v' + key + '\v' + vars[key]

		dispatch.toClient('S_SYSTEM_MESSAGE', 1, { message })
	}

	function updatePosition(event, action, special) {
		event = event || currentAction

		myPosition = {
			loc: event.loc,
			w: special ? event.w || myPosition.w : event.w, // Should be a skill flag maybe?
			action
		}
	}

	function retry(cb, count = 1) {
		if(count > settings.SKILL_RETRY_COUNT) return

		setTimeout(() => {
			if(cb()) retry(cb, count + 1)
		}, settings.SKILL_RETRY_MS)
	}

	function movePlayer(distance) {
		if(distance && !myPosition.action) applyDistance(myPosition, distance)
	}

	function applyDistance(pos, dist) {
		pos.loc.add(new Vec3(dist, 0, 0).rotate(pos.w))
		return pos
	}

	// Modifies the chain part (last 2 digits) of a skill ID, preserving flags
	function modifyChain(id, chain) {
		return id - ((id & 0x3ffffff) % 100) + chain
	}

	function skillInfo(id, local) {
		if(!local) id -= 0x4000000

		let cached = skillsCache[id]

		if(cached !== undefined) return cached

		const race = player.race,
			job = player.job,
			group = Math.floor(id / 10000),
			level = (Math.floor(id / 100) % 100) - 1,
			sub = id % 100,
			info = [ // Ordered by least specific < most specific
				get(skills, job, '*'),
				get(skills, job, '*', 'level', level),
				get(skills, job, '*', 'race', race),
				get(skills, job, '*', 'race', race, 'level', level),
				get(skills, job, group, '*'),
				get(skills, job, group, '*', 'level', level),
				get(skills, job, group, '*', 'race', race),
				get(skills, job, group, '*', 'race', race, 'level', level),
				get(skills, job, group, sub),
				get(skills, job, group, sub, 'level', level),
				get(skills, job, group, sub, 'race', race),
				get(skills, job, group, sub, 'race', race, 'level', level)
			]

		// Note: Exact skill (group, sub) must be specified for prediction to be enabled. This helps to avoid breakage in future patches
		if(info[8]) {
			cached = skillsCache[id] = Object.assign({}, ...info)
			// Sanitize to reduce memory usage
			delete cached.race
			delete cached.level
			return cached
		}

		return skillsCache[id] = null
	}

	function isMe(id) {
		return player.gameId.equals(id) || vehicleEx && vehicleEx.equals(id)
	}

	function myChar() {
		return vehicleEx ? vehicleEx : player.gameId
	}

	function getServerTimeout() {
		return ping.max + (settings.SKILL_RETRY_COUNT * settings.SKILL_RETRY_MS) + settings.SERVER_TIMEOUT
	}
}

// Utilities

function get(obj, ...keys) {
	if(obj === undefined) return

	for(let key of keys)
		if((obj = obj[key]) === undefined)
			return

	return obj
}

// Debug Utilities

function debug(msg) {
	console.log(`[${(Date.now() % 10000).toString().padStart(4, '0')}] ${msg}`)
}

function degrees(w) { return Math.round(w / Math.PI * 180) + '\xb0' }

function decimal(n, p) {
	p = 10 ** p
	return Math.round(n * p)  / p
}

function skillId(id, flagAs) {
	id |= flagAs

	const skillFlags = ['[?1]', 'N', '[?2]', '[?3]', 'C', 'S']

	let flags = ''

	for(let i = 0; i < 6; i++)
		if(id & (1 << 31 - i)) flags += skillFlags[i]

	id = (id & 0x3ffffff).toString()

	switch(flags) {
		case 'S':
			id = [id.slice(0, -4), id.slice(-4, -2), id.slice(-2)].join('-')
			break
		case 'C':
			id = [id.slice(0, -2), id.slice(-2)].join('-')
			break
	}

	return flags + id
}