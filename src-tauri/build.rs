fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    #[cfg(target_os = "macos")]
    {
        println!("cargo:rerun-if-changed=src/drag/macos.m");
        println!("cargo:rerun-if-changed=src/platform/auth_macos.m");

        cc::Build::new()
            .file("src/drag/macos.m")
            .flag("-fobjc-arc")
            .compile("openxterm_native_drag_macos");

        cc::Build::new()
            .file("src/platform/auth_macos.m")
            .flag("-fobjc-arc")
            .compile("openxterm_system_auth_macos");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=LocalAuthentication");
        println!("cargo:rustc-link-lib=framework=UniformTypeIdentifiers");
    }

    tauri_build::build()
}
