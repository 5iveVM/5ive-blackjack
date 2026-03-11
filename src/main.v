// 5IVE bundled stdlib (v1, compiler-provided)
// Canonical explicit imports:
// use std::builtins;
// use std::interfaces::spl_token;
// use std::interfaces::system_program;
// Call interface methods via module aliases:
// spl_token::transfer(...);
// system_program::transfer(...);

// Game Logic on 5IVE VM
script GameEngine {
    init() {
        log("Game Engine initialized");
    }
    
    constraints {
        // Validate player actions
        let player = get_player();
        require(player.is_active, "Player not active");
        
        // Check game state
        let game_state = get_game_state();
        require(game_state == "active", "Game not active");
    }
}

account Player {
    id: pubkey,
    level: u64,
    experience: u64,
    health: u64,
    position_x: u64,
    position_y: u64,
    inventory: [u64; 10],
    is_active: bool
}

account GameWorld {
    width: u64,
    height: u64,
    players_count: u64,
    started_at: u64
}

instruction move_player(direction: string, distance: u64) {
    let player = load_account<Player>(get_signer());
    
    match direction {
        "north" => player.position_y += distance,
        "south" => player.position_y -= distance,
        "east" => player.position_x += distance,
        "west" => player.position_x -= distance,
        _ => require(false, "Invalid direction")
    }
    
    // Validate bounds
    let world = load_account<GameWorld>(0);
    require(player.position_x < world.width, "Out of bounds");
    require(player.position_y < world.height, "Out of bounds");
    
    save_account(get_signer(), player);
    emit PlayerMoved { player: get_signer(), x: player.position_x, y: player.position_y };
}

instruction level_up() {
    let player = load_account<Player>(get_signer());
    
    let required_exp = player.level * 100;
    require(player.experience >= required_exp, "Insufficient experience");
    
    player.level += 1;
    player.experience -= required_exp;
    player.health = 100; // Full heal on level up
    
    save_account(get_signer(), player);
    emit LevelUp { player: get_signer(), new_level: player.level };
}

event PlayerMoved {
    player: pubkey,
    x: u64,
    y: u64
}

event LevelUp {
    player: pubkey,
    new_level: u64
}
