import ProjectDescription

let project = Project(
    name: "{{component_id}}",
    settings: .settings(
        configurations: [
            .debug(name: "Debug"),
            .release(name: "Release"),
        ]
    ),
    targets: [
        .target(
            name: "{{component_id}}",
            destinations: .iOS,
            product: .app,
            bundleId: "dev.sdd.{{component_id}}",
            deploymentTargets: .iOS("17.0"),
            sources: "Sources/**",
            dependencies: []
        ),
        .target(
            name: "{{component_id}}Tests",
            destinations: .iOS,
            product: .unitTests,
            bundleId: "dev.sdd.{{component_id}}Tests",
            deploymentTargets: .iOS("17.0"),
            sources: "Tests/**",
            dependencies: [.target(name: "{{component_id}}")]
        ),
    ]
)
