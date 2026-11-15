require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ElvEngineAether'
  s.version        = package['version']
  s.summary        = 'ELV IPTV Apple playback engine over AetherEngine'
  s.license        = { :type => package['license'] }
  s.author         = 'ELV IPTV'
  s.homepage       = 'https://github.com/fatihmutluu/elv-iptv'
  s.platforms      = { :ios => '18.0', :tvos => '18.0' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=appletvsimulator*]' => 'x86_64',
  }

  s.source_files = 'Engine/**/*.swift'

  raise 'spm_dependency missing' unless respond_to?(:spm_dependency, true)

  spm_dependency(s,
    url: 'https://github.com/superuser404notfound/AetherEngine.git',
    requirement: { kind: 'exactVersion', version: '7.66.1' },
    products: ['AetherEngine']
  )
end
