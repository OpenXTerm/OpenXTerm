use font_kit::source::SystemSource;

pub fn list_system_font_families() -> Result<Vec<String>, String> {
    let mut families = SystemSource::new()
        .all_families()
        .map_err(|error| format!("failed to enumerate system fonts: {error}"))?;

    families.sort_unstable_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    families.dedup_by(|left, right| left.eq_ignore_ascii_case(right));

    Ok(families)
}
