use argon2::{Algorithm, Argon2, Block, Params, Version};
use std::env;

fn decode_hex(s: &str) -> Vec<u8> {
    assert_eq!(s.len(), 296);
    (0..148)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

fn main() {
    let mut args = env::args().skip(1);
    let header = decode_hex(&args.next().expect("header hex"));
    let mode = args.next().unwrap_or_default();
    let params = Params::new(32768, 1, 1, Some(32)).unwrap();
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut memory = vec![Block::new(); 32768];
    let mut output = [0u8; 32];
    argon.hash_password_into_with_memory(
        &header,
        b"browsercoin-pow-v5",
        &mut output,
        &mut memory,
    ).unwrap();
    if mode == "final" {
        for byte in output {
            print!("{byte:02x}");
        }
        println!();
        return;
    }
    let words: &[u64] = if mode == "seed1-end" {
        &memory[1].as_ref()[120..128]
    } else if mode == "block3" {
        &memory[3].as_ref()[..8]
    } else if mode == "block130" {
        &memory[130].as_ref()[..8]
    } else if mode == "block8192" {
        &memory[8192].as_ref()[..8]
    } else if mode == "block16384" {
        &memory[16384].as_ref()[..8]
    } else if mode == "block24576" {
        &memory[24576].as_ref()[..8]
    } else if mode == "block32767" {
        &memory[32767].as_ref()[..8]
    } else {
        &memory[2].as_ref()[..8]
    };
    for byte in words.iter().flat_map(|word| word.to_le_bytes()) {
        print!("{byte:02x}");
    }
    println!();
}
