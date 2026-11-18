extends Node

const SDK = preload("res://addons/colyseus/colyseus.gd")
var client
var room
var replies := 0

func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	var peer := ENetMultiplayerPeer.new()
	if "--worker" in args:
		if peer.create_server(7778, 5) != OK:
			fail("ENet worker failed to bind")
			return
		multiplayer.multiplayer_peer = peer
		print("ENet worker listening on UDP 7778")
		return
	multiplayer.connected_to_server.connect(func(): action.rpc_id(1, 1))
	multiplayer.connection_failed.connect(func(): fail("ENet connection failed"))
	get_tree().create_timer(20).timeout.connect(func(): fail("handshake timed out"))
	var endpoint := OS.get_environment("LOBBY_URL")
	client = SDK.Client.new(endpoint if endpoint != "" else "ws://127.0.0.1:2567")
	room = client.join_or_create("handshake")
	if room == null:
		fail("Could not create lobby request")
		return
	room.error.connect(func(code, message): fail("Lobby error %s: %s" % [code, message]))
	room.joined.connect(func(): room.send_message("hello", {"protocol": 1}))
	room.message_received.connect(_on_message)

func _on_message(type: Variant, data: Variant) -> void:
	if type != "hello_ack" or not data is Dictionary or data.get("protocol") != 1:
		fail("Unexpected lobby reply")
		return
	print("Lobby typed request/reply OK")
	var peer := ENetMultiplayerPeer.new()
	if peer.create_client(OS.get_environment("WORKER_HOST") if OS.get_environment("WORKER_HOST") != "" else "127.0.0.1", 7778) != OK:
		fail("ENet client failed")
		return
	multiplayer.multiplayer_peer = peer

@rpc("any_peer", "call_remote", "reliable")
func action(sequence: int) -> void:
	if multiplayer.is_server():
		snapshot.rpc_id(multiplayer.get_remote_sender_id(), sequence)

@rpc("authority", "call_remote", "reliable")
func snapshot(sequence: int) -> void:
	replies += 1
	if replies == 1 and sequence == 1:
		print("ENet action/snapshot OK")
		room.left.connect(func(_code, _reason): action.rpc_id(1, 2))
		room.leave()
	elif replies == 2 and sequence == 2:
		print("ENet action/snapshot after lobby disconnect OK")
		multiplayer.multiplayer_peer.close()
		get_tree().quit(0)
	else:
		fail("Unexpected ENet snapshot")

func fail(message: String) -> void:
	printerr(message)
	get_tree().quit(1)
