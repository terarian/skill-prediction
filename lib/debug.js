'use strict'

const Player = require('./player')

const HOOK_FIRST = {order: -999},
	Flags = {
		Skill: 0x04000000,
		CC: 0x08000000,
		NPC: 0x40000000
	}

function SPDebug(dispatch) {
	const player = Player(dispatch)

	let enabled = false,
		hooks = []

	function load() {
		hookFirst('S_CREST_APPLY', 2, _ => [_.id, _.enable ? 'on' : 'off'])
		hookFirst('S_CREST_MESSAGE', 2, _ => [_.unk, _.type, skillId(_.skill, Flags.Skill)])

		hookFirst('C_CANCEL_SKILL', 1, _ => [skillId(_.skill), _.type])

		hookFirst('S_GRANT_SKILL', 1, _ => skillId(_.skill))
		hookFirst('S_CANNOT_START_SKILL', 1, _ => skillId(_.skill, Flags.Skill))
	}

	function unload() {
		if(hooks.length) {
			for(let h of hooks) dispatch.unhook(h)

			hooks = []
		}
	}

	function hookFirst(name, ver, cb) {
		hooks.push(dispatch.hook(name, ver, HOOK_FIRST), event => {
			let out = cb(event, name)

			debug(`${_.$incoming ? '<-' : '->'} ${name} ${Array.isArray(out) ? out.join(' ') : out}`)
		})
	}

	return {
		toggle() {
			(enabled = !enabled) ? load() : unload()

			if(enabled) debug(`SP debug enabled. Race=${player.race} Class=${player.job}`)

			return enabled
		}
	}
}

// Utilities

function debug() {
	console.log(`[${(Date.now() % 10000).toString().padStart(4, '0')}]`, ...arguments)
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

/* Require() */

let map = new WeakMap()

module.exports = function Require(dispatch) {
	if(map.has(dispatch.base)) return map.get(dispatch.base)

	let mod = SPDebug(dispatch)
	map.set(dispatch.base, mod)
	return mod
}