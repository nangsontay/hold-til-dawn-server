extends SceneTree

class Client extends "res://main.gd":
	func _ready() -> void:
		super._ready()
		for skin in ROLE_SKIN:
			csheet[skin] = load(CHARS + skin + ".png")
		_build_ui()
		name_edit.text = "Release check"
		role_opt.selected = 2
		_open_directory()

func _initialize() -> void:
	_run.call_deferred()

func _wait_for(condition: Callable) -> bool:
	var deadline := Time.get_ticks_msec() + 12000
	while not condition.call():
		if Time.get_ticks_msec() >= deadline:
			push_error("Release client timed out")
			quit(1)
			return false
		await process_frame
	return true

func _run() -> void:
	create_timer(30.0).timeout.connect(func(): quit(1))
	var branch := Node.new()
	branch.name = "ReleaseClient"
	root.add_child(branch)
	set_multiplayer(SceneMultiplayer.new(), branch.get_path())
	var client := Client.new()
	client.name = "Main"
	branch.add_child(client)
	if not await _wait_for(func(): return client.directory.create_available): return
	client.create_btn.pressed.emit()
	if not await _wait_for(func(): return client.snap.get("room", {}).get("state") == "waiting"): return
	client._act("add_bot", 0)
	client._act("ready", true)
	if not await _wait_for(func(): return client.snap.get("room", {}).get("ready", []).has(client.my_id)): return
	await create_timer(1.0).timeout
	if not client.snap.room.bots.is_empty():
		push_error("Release worker accepted a development bot")
		quit(1)
		return
	print("Release worker admitted the leader and rejected add_bot")
	client._back_to_menu("Done")
	quit(0)
