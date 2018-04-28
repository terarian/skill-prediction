'use strict'

const Command = require('command'),
	Ping = require('./ping'),
	Debug = require('./debug')

module.exports = function SPCommands(dispatch) {
	const command = Command(dispatch),
		ping = Ping(dispatch),
		debug = Debug(dispatch)

	command.add('sp', {
		$default(cmd) { message(`Unknown command "${cmd}".`) },
		$none: printHelp,
		help: printHelp,
		ping: printPing,
		debug() { message(`Debug ${debug.toggle() ? 'enabled' : 'disabled'}.`) }
	})

	command.add('ping', printPing)

	function printHelp() {
		message(`Commands:
<FONT COLOR="#FFFFFF">ping</FONT> = Display ping statistics.
<FONT COLOR="#FFFFFF">debug</FONT> = Toggle debug mode.`)
	}

	function printPing() {
		command.message(`Ping: ${ping.history.length ? `Avg=${Math.round(ping.avg)} Min=${ping.min} Max=${ping.max} Jitter=${ping.max - ping.min} Samples=${ping.history.length}` : '???'}`)
	}

	function message(msg) {
		command.message(`[Skill Prediction] ${msg}`)
	}
}